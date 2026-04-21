/**
 * MemoryRememberer - MemoryManager 분해 (Phase 5-B)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 *
 * 이관 대상: remember / batchRemember / amend / forget / _supersede /
 *            _rememberAtomic / _finalizeRemember / _recordCaseEvent
 *
 * 공개 API 계약은 MemoryManager와 100% 동일하게 유지한다.
 * MemoryManager.js는 이 클래스를 위임 호출하는 facade로 축소될 예정이다.
 */

import crypto                            from "crypto";
import { getPrimaryPool }                from "../../tools/db.js";
import { buildSearchPath }               from "../../config.js";
import { MEMORY_CONFIG }                 from "../../../config/memory.js";
import { logWarn }                       from "../../logger.js";
import { SYMBOLIC_CONFIG }               from "../../../config/symbolic.js";
import { symbolicMetrics }               from "../../symbolic/SymbolicMetrics.js";
import { SymbolicPolicyViolationError }  from "../../symbolic/errors.js";

export class MemoryRememberer {
  /**
   * @param {Object} deps
   * @param {import("../FragmentStore.js").FragmentStore}               deps.store
   * @param {import("../FragmentIndex.js").FragmentIndex}               deps.index
   * @param {import("../FragmentFactory.js").FragmentFactory}           deps.factory
   * @param {import("../QuotaChecker.js").QuotaChecker}                deps.quotaChecker
   * @param {import("../RememberPostProcessor.js").RememberPostProcessor} deps.postProcessor
   * @param {import("../ConflictResolver.js").ConflictResolver}         deps.conflictResolver
   * @param {import("../CaseEventStore.js").CaseEventStore}             deps.caseEventStore
   * @param {import("../../symbolic/PolicyRules.js").PolicyRules}       deps.policyRules
   * @param {import("../SessionLinker.js").SessionLinker}               deps.sessionLinker
   * @param {import("../BatchRememberProcessor.js").BatchRememberProcessor} deps.batchRememberProcessor
   * @param {import("../../symbolic/LinkIntegrityChecker.js").LinkIntegrityChecker} deps.linkChecker
   * @param {Function}  deps.getHardGate           - (keyId: string) => Promise<boolean>
   * @param {boolean|null} deps.policyGatingEnabled - null 이면 SYMBOLIC_CONFIG 값 사용
   * @param {import("../MorphemeIndex.js").MorphemeIndex} [deps.morphemeIndex]
   */
  constructor({
    store,
    index,
    factory,
    quotaChecker,
    postProcessor,
    conflictResolver,
    caseEventStore,
    policyRules,
    sessionLinker,
    batchRememberProcessor,
    linkChecker,
    getHardGate,
    policyGatingEnabled,
    morphemeIndex
  } = {}) {
    this.store                 = store;
    this.index                 = index;
    this.factory               = factory;
    this.quotaChecker          = quotaChecker;
    this.postProcessor         = postProcessor;
    this.conflictResolver      = conflictResolver;
    this.caseEventStore        = caseEventStore;
    this.policyRules           = policyRules;
    this.sessionLinker         = sessionLinker;
    this.batchRememberProcessor = batchRememberProcessor;
    this.linkChecker           = linkChecker;
    this.morphemeIndex         = morphemeIndex;

    /**
     * hard gate 조회 함수. 기본값은 ApiKeyStore.getSymbolicHardGate.
     * 단위 테스트에서 인스턴스 프로퍼티 교체로 mock 주입 가능.
     * @type {(keyId: string) => Promise<boolean>}
     */
    this._getHardGate = getHardGate;

    /**
     * Phase 4 Soft/Hard Gating 활성화 여부.
     * SYMBOLIC_CONFIG.enabled && SYMBOLIC_CONFIG.policyRules를 기본값으로 하지만
     * 단위 테스트에서 인스턴스 레벨로 true 설정 가능.
     * null이면 SYMBOLIC_CONFIG 값을 사용.
     * @type {boolean|null}
     */
    this._policyGatingEnabled = policyGatingEnabled !== undefined ? policyGatingEnabled : null;
  }

  /** fragment type → case event type 매핑 */
  static FRAG_TO_EVENT = {
    error    : "error_observed",
    decision : "decision_committed",
    procedure: "fix_attempted"
  };

  /**
   * remember - 파편 기억
   *
   * @param {Object} params
   *   - content   {string} 기억할 내용
   *   - topic     {string} 주제
   *   - type      {string} fact|decision|error|preference|procedure|relation
   *   - keywords  {string[]} 키워드 (선택)
   *   - importance {number} 중요도 0~1 (선택)
   *   - source    {string} 출처 (선택)
   *   - linkedTo  {string[]} 연결 파편 ID (선택)
   *   - agentId   {string} 에이전트 ID (선택)
   *   - sessionId {string} 세션 ID (선택)
   *   - scope     {string} permanent|session (기본 permanent)
   * @returns {Object} { id, keywords, ttl_tier, scope }
   */
  async remember(params) {
    const scope       = params.scope || "permanent";
    const agentId     = params.agentId || "default";
    const keyId       = params._keyId ?? null;
    const groupKeyIds = params._groupKeyIds ?? (keyId != null ? [keyId] : null);
    const sessionId   = params.sessionId || params._sessionId || null;
    const workspace   = params.workspace ?? params._defaultWorkspace ?? null;
    const source      = params.source ?? (sessionId ? `session:${sessionId.slice(0, 8)}` : null);

    /**
     * scope=session: Working Memory에만 저장 (Redis, 세션 종료 시 소멸)
     * PostgreSQL에는 저장하지 않아 세션 간 오염을 방지한다.
     */
    if (scope === "session" && sessionId) {
      const fragment = this.factory.create({
        ...params,
        contextSummary: params.contextSummary || null,
        sessionId
      });
      await this.index.addToWorkingMemory(sessionId, fragment);

      return {
        id       : fragment.id,
        keywords : fragment.keywords,
        ttl_tier : "session",
        scope    : "session",
        conflicts: []
      };
    }

    /**
     * idempotency_key 중복 검사.
     * 같은 key_id 범위에서 동일한 idempotencyKey로 호출하면 기존 파편을 즉시 반환한다.
     * DB 인덱스(idx_fragments_idempotency_tenant / idx_fragments_idempotency_master)로
     * 보장하는 유일성과 일치하며, quota 소모 없이 안전하게 재시도를 허용한다.
     */
    if (params.idempotencyKey) {
      const existing = await this.store.findByIdempotencyKey(params.idempotencyKey, keyId);
      if (existing) {
        return {
          id         : existing.id,
          keywords   : existing.keywords ?? [],
          ttl_tier   : existing.ttl_tier,
          scope      : "persistent",
          conflicts  : [],
          idempotent : true,
          existing   : true
        };
      }
    }

    /**
     * M5 dryRun: 파편 생성 없이 실행 계획(할당량·충돌·검증 경고)을 반환한다.
     * factory.create / policyRules.check / quotaChecker.getUsage는 side-effect free이므로
     * 호출하되 store.insert / index.index / postProcessor.run은 완전 생략한다.
     * R12 atomic 경로의 TDZ 가드는 이 분기보다 아래에 위치하므로 영향 없다.
     */
    if (params.dryRun === true) {
      const dryFragment = this.factory.create({
        ...params,
        source         : source,
        contextSummary : params.contextSummary || null,
        sessionId,
        isAnchor       : params.isAnchor || false,
        affect         : params.affect   || undefined
      });
      dryFragment.agent_id  = params.agentId || "default";
      dryFragment.key_id    = keyId;
      dryFragment.workspace = workspace;

      const conflicts = await this.conflictResolver.detectConflicts(
        dryFragment.content, dryFragment.topic, null, dryFragment.agent_id, keyId
      ).catch(() => []);

      const validationWarnings = [];
      try {
        const _policyActive = this._policyGatingEnabled !== null
          ? this._policyGatingEnabled
          : (SYMBOLIC_CONFIG.enabled && SYMBOLIC_CONFIG.policyRules);
        if (_policyActive) {
          const violations = this.policyRules.check(dryFragment);
          if (violations.length > 0) {
            validationWarnings.push(...violations.map(v =>
              typeof v === "object" && v !== null && v.rule ? String(v.rule) : String(v)
            ));
          }
        }
      } catch (_) { /* soft gate 실패는 swallow */ }

      const quota = await this.quotaChecker.getUsage(keyId).catch(() => ({
        limit: null, current: 0, remaining: null, resetAt: null
      }));

      return {
        dryRun   : true,
        simulated: {
          fragment: {
            id          : "<would-generate>",
            type        : dryFragment.type,
            content     : dryFragment.content,
            keywords    : dryFragment.keywords,
            importance  : dryFragment.importance,
            ttl_tier    : dryFragment.ttl_tier
          },
          conflicts           : conflicts.map(c => ({ id: c.id, content: c.content })),
          validation_warnings : validationWarnings,
          quota
        }
      };
    }

    /**
     * 할당량 초과 검사.
     *
     * MEMENTO_REMEMBER_ATOMIC=true: BEGIN → api_keys FOR UPDATE(quota 재검증) →
     *   FragmentWriter.insert(client) → COMMIT 단일 트랜잭션. TOCTOU 완전 차단.
     *   BatchRememberProcessor Phase B와 동일한 SELECT 조건·잠금 범위 사용.
     *
     * MEMENTO_REMEMBER_ATOMIC=false(기본): QuotaChecker.check()를 선제 검사로만 사용.
     *   동시 요청이 드문 환경에서 기존 성능·동작을 그대로 보존한다.
     */
    const atomicRemember = process.env.MEMENTO_REMEMBER_ATOMIC === "true";

    /**
     * atomic=true 경로는 _rememberAtomic 내부 트랜잭션의 FOR UPDATE 잠금으로
     * quota 재검증을 수행하므로 pre-check를 생략하여 중복 SELECT를 제거한다.
     */
    if (!(atomicRemember && keyId)) {
      await this.quotaChecker.check(keyId);
    }

    /** case_id 자동 할당: 동일 session+topic의 error 흐름 감지 */
    const AUTO_CASE_TYPES = new Set(["error", "procedure", "decision"]);
    if (!params.caseId && sessionId && params.topic && AUTO_CASE_TYPES.has(params.type)) {
      const existingCaseId = await this.store.findCaseIdBySessionTopic(sessionId, params.topic, keyId);
      if (existingCaseId) {
        params = { ...params, caseId: existingCaseId };
      } else if (params.type === "error") {
        params = { ...params, caseId: crypto.randomUUID() };
      } else {
        const errorIds = await this.store.findErrorFragmentsBySessionTopic(sessionId, params.topic, keyId);
        if (errorIds.length > 0) {
          const newCaseId = crypto.randomUUID();
          params = { ...params, caseId: newCaseId };
          Promise.all(errorIds.map(id => this.store.updateCaseId(id, newCaseId, keyId)))
            .catch(err => logWarn(`[MemoryRememberer] auto-case-id backfill failed: ${err.message}`));
        }
      }
    }

    const fragment = this.factory.create({
      ...params,
      source         : source,
      contextSummary : params.contextSummary || null,
      sessionId,
      isAnchor       : params.isAnchor || false,
      affect         : params.affect   || undefined
    });
    fragment.agent_id  = agentId;    // 명시적으로 에이전트 ID 설정
    fragment.key_id    = keyId;      // API 키 격리: 해당 키 소유 파편으로 마킹
    fragment.workspace = workspace;  // 워크스페이스 격리

    if (atomicRemember && keyId) {
      return await this._rememberAtomic(fragment, { agentId, keyId, groupKeyIds, params });
    }

    /**
     * Phase 4 Soft Gating: PolicyRules 구조적 제약 검사 (advisory).
     * 위반 시 fragment.validation_warnings에 누적하고 warning 메트릭 증가.
     * store.insert는 계속 진행 (block 금지) — soft gate 기본 동작.
     * 기본값 SYMBOLIC_CONFIG.policyRules=false에서는 no-op.
     *
     * Hard gate: api_keys.symbolic_hard_gate=true인 키에서 violations 발생 시
     * SymbolicPolicyViolationError를 throw하여 store.insert를 차단한다.
     * 마스터 키(keyId=null)는 항상 soft gate만 적용된다.
     */
    const _policyActive = this._policyGatingEnabled !== null
      ? this._policyGatingEnabled
      : (SYMBOLIC_CONFIG.enabled && SYMBOLIC_CONFIG.policyRules);
    if (_policyActive) {
      try {
        const violations = this.policyRules.check(fragment);
        if (violations.length > 0) {
          /** Soft accumulation — 기존 동작 유지 */
          fragment.validation_warnings = Array.isArray(fragment.validation_warnings)
            ? [...fragment.validation_warnings, ...violations]
            : violations;
          for (const v of violations) {
            symbolicMetrics.recordWarning(`policy.${v.rule}`, v.severity || "low");
          }

          /** Hard gate — 키별 opt-in. master(keyId=null)는 제외 */
          if (keyId != null) {
            const hardGate = await this._getHardGate(keyId);
            if (hardGate) {
              symbolicMetrics.recordGateBlock("policy", violations[0]?.rule ?? "unknown");
              throw new SymbolicPolicyViolationError(violations, {
                fragmentType: fragment.type,
                keyId
              });
            }
          }
        }
      } catch (err) {
        /** SymbolicPolicyViolationError는 상위로 전파. 그 외는 swallow */
        if (err instanceof SymbolicPolicyViolationError) throw err;
        logWarn(`[MemoryRememberer] policy rules check failed: ${err.message}`);
      }
    }

    const id       = await this.store.insert(fragment);

    await this.index.index({ ...fragment, id }, params.sessionId, fragment.key_id ?? null);

    /** 후처리 파이프라인 (임베딩, 형태소, 링크, assertion, 시간링크, 평가큐) */
    await this.postProcessor.run({ ...fragment, id }, { agentId, keyId, groupKeyIds });

    /** 충돌 감지 (agentId, keyId 전달 — 동일 키 범위 내에서만 감지) */
    const conflicts = await this.conflictResolver.detectConflicts(fragment.content, fragment.topic, id, agentId, keyId);

    /** 자동 링크 생성 (유사 파편 기반) */
    await this.conflictResolver.autoLinkOnRemember({ ...fragment, id }, agentId).catch(err => {
      logWarn(`[MemoryRememberer] autoLinkOnRemember failed: ${err.message}`);
    });

    /** 명시적 대체 처리: supersedes에 지정된 파편을 만료시킨다 */
    if (params.supersedes && Array.isArray(params.supersedes)) {
      for (const oldId of params.supersedes) {
        if (oldId === id) continue;
        try {
          await this._supersede(oldId, id, agentId, keyId);
        } catch (err) {
          logWarn(`[MemoryRememberer] supersede ${oldId} failed: ${err.message}`);
        }
      }
    }

    /** 낮은 importance 경고 및 TTL 자동 하향 */
    const effectiveImportance = fragment.importance ?? 0.5;
    let lowImportanceWarning  = undefined;
    let effectiveTtlTier      = fragment.ttl_tier;

    if (effectiveImportance < 0.3) {
      lowImportanceWarning = "이 내용은 낮은 중요도로 저장됩니다. 장기 보존이 필요하면 importance를 명시하세요.";
      if (!params.ttl_tier) {
        effectiveTtlTier = "short";
        await this.store.updateTtlTier(id, "short", keyId).catch(err => {
          logWarn(`[MemoryRememberer] ttl_tier update failed: ${err.message}`);
        });
      }
    }

    const result = {
      id,
      keywords : fragment.keywords,
      ttl_tier : effectiveTtlTier,
      scope    : "permanent",
      conflicts
    };

    /** Phase 4 Soft Gating 결과 노출 (violations 있을 때만, rule 이름만 추출) */
    if (Array.isArray(fragment.validation_warnings) && fragment.validation_warnings.length > 0) {
      result.validation_warnings = fragment.validation_warnings.map(v =>
        typeof v === "object" && v !== null && v.rule ? String(v.rule) : String(v)
      );
    }

    if (lowImportanceWarning) {
      result.low_importance_warning = lowImportanceWarning;
    }

    /** case_events 자동 기록 (fire-and-forget — case_id 있는 파편만) */
    if (fragment.case_id && this.caseEventStore) {
      this._recordCaseEvent({ ...fragment, id }, keyId).catch(err =>
        logWarn(`[MemoryRememberer] case event recording failed: ${err.message}`)
      );
    }

    return result;
  }

  /**
   * TOCTOU-safe 단일 트랜잭션 remember 경로.
   * MEMENTO_REMEMBER_ATOMIC=true이고 keyId가 존재할 때만 호출된다.
   *
   * BEGIN → api_keys FOR UPDATE → 현재 fragment 수 재검증 →
   * FragmentWriter.insert(client) → COMMIT 순서로 원자 실행한다.
   * BatchRememberProcessor._checkQuotaPhaseB와 동일한 SELECT 조건·잠금 범위를 사용한다.
   *
   * @param {Object} fragment          - factory.create() 이후의 파편 객체 (id 포함)
   * @param {Object} ctx
   * @param {string}      ctx.agentId
   * @param {string}      ctx.keyId
   * @param {string[]|null} ctx.groupKeyIds
   * @param {Object}      ctx.params   - remember() 원본 params (postProcessor 등 후속 처리용)
   * @returns {Promise<Object>} remember() 반환 구조와 동일
   */
  async _rememberAtomic(fragment, { agentId, keyId, groupKeyIds, params }) {
    const pool = getPrimaryPool();
    if (!pool) {
      /** DB 없음 — 기존 경로로 폴백 */
      await this.quotaChecker.check(keyId);
      const id = await this.store.insert(fragment);
      return this._finalizeRemember({ ...fragment, id }, { agentId, keyId, groupKeyIds, params });
    }

    const SCHEMA    = "agent_memory";
    const safeAgent = String(agentId || "default").replace(/[^a-zA-Z0-9_-]/g, "");
    const client    = await pool.connect();

    let id;
    try {
      await client.query(buildSearchPath(SCHEMA));
      await client.query("BEGIN");
      await client.query("SET LOCAL app.current_agent_id = 'system'");

      /** BatchRememberProcessor._checkQuotaPhaseB와 동일한 잠금·SELECT */
      const { rows: [keyRow] } = await client.query(
        `SELECT fragment_limit FROM ${SCHEMA}.api_keys WHERE id = $1 FOR UPDATE`,
        [keyId]
      );

      if (keyRow && keyRow.fragment_limit !== null) {
        const { rows: [countRow] } = await client.query(
          `SELECT COUNT(*)::int AS count FROM ${SCHEMA}.fragments
           WHERE key_id = $1 AND valid_to IS NULL`,
          [keyId]
        );
        if (countRow.count >= keyRow.fragment_limit) {
          await client.query("ROLLBACK");
          const err   = new Error(
            `Fragment limit reached (${countRow.count}/${keyRow.fragment_limit}). Delete unused fragments or request a higher limit.`
          );
          err.code    = "fragment_limit_exceeded";
          err.current = countRow.count;
          err.limit   = keyRow.fragment_limit;
          throw err;
        }
      }

      /** SET LOCAL을 agentId로 전환 후 INSERT — FragmentWriter가 safeAgent 재설정 */
      id = await this.store.writer.insert(fragment, { client });

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    return this._finalizeRemember({ ...fragment, id }, { agentId, keyId, groupKeyIds, params });
  }

  /**
   * INSERT 이후 공통 후속 처리(index, postProcessor, conflict, supersedes 등)를
   * 담당하는 내부 헬퍼. remember()와 _rememberAtomic()이 공유한다.
   *
   * @param {Object} fragment   - id가 확정된 파편 객체
   * @param {Object} ctx
   * @returns {Promise<Object>} remember() 반환 구조
   */
  async _finalizeRemember(fragment, { agentId, keyId, groupKeyIds, params }) {
    const id = fragment.id;

    await this.index.index(fragment, fragment.session_id, fragment.key_id ?? null);
    await this.postProcessor.run(fragment, { agentId, keyId, groupKeyIds });

    const conflicts = await this.conflictResolver.detectConflicts(
      fragment.content, fragment.topic, id, agentId, keyId
    );

    await this.conflictResolver.autoLinkOnRemember(fragment, agentId).catch(err => {
      logWarn(`[MemoryRememberer] autoLinkOnRemember failed: ${err.message}`);
    });

    if (params.supersedes && Array.isArray(params.supersedes)) {
      for (const oldId of params.supersedes) {
        if (oldId === id) continue;
        try {
          await this._supersede(oldId, id, agentId, keyId);
        } catch (err) {
          logWarn(`[MemoryRememberer] supersede ${oldId} failed: ${err.message}`);
        }
      }
    }

    const effectiveImportance = fragment.importance ?? 0.5;
    let   lowImportanceWarning;
    let   effectiveTtlTier    = fragment.ttl_tier;

    if (effectiveImportance < 0.3) {
      lowImportanceWarning = "이 내용은 낮은 중요도로 저장됩니다. 장기 보존이 필요하면 importance를 명시하세요.";
      if (!params.ttl_tier) {
        effectiveTtlTier = "short";
        await this.store.updateTtlTier(id, "short", keyId).catch(err => {
          logWarn(`[MemoryRememberer] ttl_tier update failed: ${err.message}`);
        });
      }
    }

    const result = {
      id,
      keywords      : fragment.keywords,
      ttl_tier      : effectiveTtlTier,
      scope         : "persistent",
      conflicts     : conflicts.map(c => ({
        id      : c.id,
        content : c.content,
        type    : "potential_conflict"
      }))
    };

    if (lowImportanceWarning) {
      result.low_importance_warning = lowImportanceWarning;
    }

    if (fragment.case_id && this.caseEventStore) {
      this._recordCaseEvent(fragment, keyId).catch(err =>
        logWarn(`[MemoryRememberer] case event recording failed: ${err.message}`)
      );
    }

    return result;
  }

  /**
   * case_id가 있는 파편에 대해 case_events에 이벤트를 기록한다.
   * fragment_evidence(produced_by), preceded_by 엣지, resolved_by 엣지를 자동 생성한다.
   *
   * @param {Object}      fragment - id가 포함된 파편 객체
   * @param {number|null} keyId
   */
  async _recordCaseEvent(fragment, keyId) {
    const eventType = MemoryRememberer.FRAG_TO_EVENT[fragment.type];
    if (!eventType) return;

    const { event_id } = await this.caseEventStore.append({
      case_id           : fragment.case_id,
      session_id        : fragment.session_id ?? null,
      event_type        : eventType,
      summary           : (fragment.content || "").slice(0, 200),
      entity_keys       : fragment.keywords || [],
      source_fragment_id: fragment.id,
      key_id            : keyId
    });

    /** fragment_evidence: 이 파편이 이벤트의 근거 */
    await this.caseEventStore.addEvidence(fragment.id, event_id, "produced_by").catch(() => {});

    /** preceded_by: 동일 case_id의 직전 이벤트와 연결 */
    const prevEvents = await this.caseEventStore.getByCase(fragment.case_id, { limit: 2, keyId });
    const prevEvent  = prevEvents.find(e => e.event_id !== event_id);
    if (prevEvent) {
      await this.caseEventStore.addEdge(event_id, prevEvent.event_id, "preceded_by").catch(() => {});
    }

    /** resolved_by: procedure가 동일 case의 error를 해결 */
    if (eventType === "fix_attempted") {
      const errorEvents = await this.caseEventStore.getByCase(
        fragment.case_id,
        { eventType: "error_observed", keyId }
      );
      for (const errEvt of errorEvents) {
        await this.caseEventStore.addEdge(event_id, errEvt.event_id, "resolved_by").catch(() => {});
      }
    }
  }

  /**
   * batchRemember - 복수 파편 일괄 저장
   *
   * BatchRememberProcessor에 위임한다.
   *
   * @param {Object} params
   *   - fragments {Array<Object>} 파편 배열
   *   - agentId   {string}       에이전트 ID (선택)
   *   - _keyId    {string|null}  API 키 ID (선택)
   * @returns {{ results: Array<{id, success, error?}>, inserted: number, skipped: number }}
   */
  async batchRemember(params, onProgress = null) {
    return this.batchRememberProcessor.process(params, onProgress);
  }

  /**
   * 기존 파편을 새 파편으로 대체한다 (ConflictResolver.supersede 위임 래퍼).
   * tests/unit/supersedes-param.test.js 가 존재/위임 패턴을 명시적으로 검증하므로 유지.
   *
   * - superseded_by 링크 생성
   * - 구 파편의 valid_to 를 현재 시각으로 설정
   * - 구 파편의 importance 를 반감
   *
   * @param {string}      oldId   - 대체될 파편 ID
   * @param {string}      newId   - 대체하는 파편 ID
   * @param {string}      agentId
   * @param {string|null} keyId
   */
  async _supersede(oldId, newId, agentId = "default", keyId = null) {
    return this.conflictResolver.supersede(oldId, newId, agentId, keyId);
  }

  /**
   * amend - 기존 파편의 content/metadata를 갱신
   * ID와 linked_to(링크)를 보존하면서 내용만 교체한다.
   *
   * @param {Object} params
   *   - id         {string} 갱신 대상 파편 ID (필수)
   *   - content    {string} 새 내용 (선택)
   *   - topic      {string} 새 주제 (선택)
   *   - keywords   {string[]} 새 키워드 (선택)
   *   - type       {string} 새 유형 (선택)
   *   - importance {number} 새 중요도 (선택)
   *   - agentId    {string} 에이전트 ID (선택)
   * @returns {Object} { updated, fragment }
   */
  async amend(params) {
    if (!params.id) {
      return { updated: false, error: "id is required" };
    }

    const agentId     = params.agentId || "default";
    const keyId       = params._keyId ?? null;
    const groupKeyIds = params._groupKeyIds ?? params.groupKeyIds ?? [];
    const existing    = await this.store.getById(params.id, agentId, keyId, groupKeyIds);
    if (!existing) {
      return { updated: false, error: "Fragment not found or no permission" };
    }

    /** M5 dryRun: 패치를 병합한 예상 파편 상태를 반환. 실제 UPDATE 생략. */
    if (params.dryRun === true) {
      const wouldBe = { ...existing };
      if (params.content   !== undefined) wouldBe.content     = params.content;
      if (params.topic     !== undefined) wouldBe.topic       = params.topic;
      if (params.keywords  !== undefined && Array.isArray(params.keywords)) {
        wouldBe.keywords = params.keywords.map(k => k.toLowerCase());
      }
      if (params.type      !== undefined) wouldBe.type        = params.type;
      if (params.importance!== undefined) wouldBe.importance  = params.importance;
      if (params.isAnchor  !== undefined) wouldBe.is_anchor   = params.isAnchor;
      if (params.assertionStatus !== undefined) wouldBe.assertion_status = params.assertionStatus;

      return {
        dryRun   : true,
        simulated: {
          would_be_fragment: {
            id              : wouldBe.id,
            type            : wouldBe.type,
            content         : wouldBe.content,
            topic           : wouldBe.topic,
            keywords        : wouldBe.keywords,
            importance      : wouldBe.importance,
            is_anchor       : wouldBe.is_anchor,
            assertion_status: wouldBe.assertion_status
          }
        }
      };
    }

    const updates = {};
    if (params.content !== undefined) {
      updates.content = params.content;
    }
    if (params.topic !== undefined)           updates.topic            = params.topic;
    if (params.keywords !== undefined && Array.isArray(params.keywords)) {
      updates.keywords = params.keywords.map(k => k.toLowerCase());
    }
    if (params.type !== undefined)            updates.type             = params.type;
    if (params.importance !== undefined)      updates.importance       = params.importance;
    if (params.isAnchor !== undefined)        updates.is_anchor        = params.isAnchor;
    if (params.assertionStatus !== undefined) updates.assertion_status = params.assertionStatus;

    const result = await this.store.update(params.id, updates, agentId, keyId, existing);

    if (!result) {
      return { updated: false, error: "Update failed" };
    }

    if (result.merged) {
      return { updated: false, merged: true, existingId: result.existingId };
    }

    if (params.supersedes) {
      /**
       * in-place update 구조에서 superseded_by 자기참조 링크는 무의미.
       * archive(fragment_versions INSERT)로 이력이 보존되며,
       * verified_at은 update() 내부에서 NOW()로 갱신된다.
       */
    }

    /** Redis 인덱스 갱신: 기존 제거 후 재등록 */
    await this.index.deindex(existing.id, existing.keywords, existing.topic, existing.type, existing.key_id ?? null);
    await this.index.index(result, null, existing.key_id ?? null);

    /** assertion_status 변경 시 case_events 기록 (fire-and-forget) */
    if (
      params.assertionStatus &&
      existing.assertion_status !== params.assertionStatus &&
      existing.case_id &&
      this.caseEventStore
    ) {
      const amendEventType = params.assertionStatus === "verified" ? "verification_passed"
                           : params.assertionStatus === "rejected" ? "verification_failed"
                           : null;
      if (amendEventType) {
        this.caseEventStore.append({
          case_id           : existing.case_id,
          session_id        : existing.session_id ?? null,
          event_type        : amendEventType,
          summary           : (existing.content || "").slice(0, 200),
          source_fragment_id: existing.id,
          entity_keys       : existing.keywords || [],
          key_id            : keyId
        }).then(({ event_id }) =>
          this.caseEventStore.addEvidence(existing.id, event_id, "produced_by").catch(() => {})
        ).catch(err => logWarn(`[MemoryRememberer] amend event recording failed: ${err.message}`));
      }
    }

    return { updated: true, fragment: result };
  }

  /**
   * forget - 파편 망각
   *
   * @param {Object} params
   *   - id          {string} 특정 파편 ID
   *   - topic       {string} 주제 전체 삭제
   *   - beforeDays  {number} N일 전 이전 파편 삭제
   *   - force       {boolean} permanent 파편도 삭제 여부
   * @returns {Object} { deleted, protected }
   */
  async forget(params) {
    const agentId      = params.agentId || "default";
    const keyId        = params._keyId ?? null;
    const groupKeyIds  = params._groupKeyIds ?? (keyId ? [keyId] : null);
    let deleted    = 0;
    let protected_ = 0;

    /** M5 dryRun: 삭제 없이 대상 파편 정보 + 연결 링크 수 반환 */
    if (params.dryRun === true && params.id) {
      const frag = await this.store.getById(params.id, agentId, keyId, groupKeyIds);
      if (!frag) return { dryRun: true, simulated: null, error: "Fragment not found or no permission" };

      const linkedCount = Array.isArray(frag.linked_to) ? frag.linked_to.length : 0;
      const wouldDelete = !(frag.ttl_tier === "permanent" && !params.force);

      return {
        dryRun   : true,
        simulated: {
          fragment    : { id: frag.id, type: frag.type, content: frag.content, ttl_tier: frag.ttl_tier },
          linked_count: linkedCount,
          would_delete: wouldDelete,
          reason      : wouldDelete ? null : "permanent 파편은 force 옵션 필요"
        }
      };
    }

    if (params.id) {
      const frag = await this.store.getById(params.id, agentId, keyId, groupKeyIds);
      if (!frag) return { deleted: 0, protected: 0, error: "Fragment not found or no permission" };

      if (frag.ttl_tier === "permanent" && !params.force) {
        return { deleted: 0, protected: 1, reason: "permanent 파편은 force 옵션 필요" };
      }

      await this.index.deindex(frag.id, frag.keywords, frag.topic, frag.type, frag.key_id ?? null);
      const ok = await this.store.delete(frag.id, agentId, keyId);
      deleted  = ok ? 1 : 0;
    }

    if (params.topic) {
      const topicFrags = await this.store.searchByTopic(params.topic, {
        agentId,
        keyId: groupKeyIds ?? (keyId ? [keyId] : undefined),
        includeSuperseded: true,
        limit: 200,
      });

      const toDelete = [];
      for (const frag of topicFrags) {
        /** API 키 소유권 검사 (그룹 인식) */
        if (keyId && frag.key_id !== keyId && (!groupKeyIds || !groupKeyIds.includes(frag.key_id))) {
          protected_++;
          continue;
        }

        if (frag.ttl_tier === "permanent" && !params.force) {
          protected_++;
          continue;
        }

        toDelete.push(frag);
      }

      if (toDelete.length > 0) {
        /** Redis deindex 병렬 처리 */
        await Promise.all(
          toDelete.map(frag =>
            this.index.deindex(frag.id, frag.keywords, frag.topic, frag.type, frag.key_id ?? null)
              .catch(err => logWarn(`[MemoryRememberer] deindex failed: ${err.message}`))
          )
        );

        /** 단일 DELETE ... WHERE id = ANY($1) */
        const deleteCount = await this.store.deleteMany(
          toDelete.map(f => f.id),
          agentId,
          keyId
        );
        deleted += deleteCount;
      }
    }

    return { deleted, protected: protected_ };
  }
}
