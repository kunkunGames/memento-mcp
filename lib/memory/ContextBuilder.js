/**
 * ContextBuilder — context() 로직 전담 모듈
 *
 * 작성자: 최진호
 * 작성일: 2026-04-05
 *
 * MemoryManager.context() 330줄 본문을 추출.
 * Core Memory, Working Memory, Anchor Memory를 조합하여 컨텍스트를 생성한다.
 */

import { MEMORY_CONFIG }   from "../../config/memory.js";
import { getPrimaryPool }  from "../tools/db.js";
import { logWarn }         from "../logger.js";
import { AUXILIARY_SECTION_CATALOG, planAuxiliarySections } from "./AuxiliarySectionPlanner.js";

/**
 * context 응답에 포함할 힌트를 생성한다.
 * AI가 다음 행동을 능동적으로 결정할 수 있도록 signal + suggestion을 제공.
 */
function buildContextHint(fragments) {
  const errorFrags = fragments.filter(f => f.type === "error");
  if (errorFrags.length > 0) {
    return {
      signal    : "active_errors",
      suggestion: `미해결 에러 파편 ${errorFrags.length}개 있음. 이미 해결된 항목은 forget으로 정리하세요.`,
      trigger   : "forget"
    };
  }
  if (fragments.length === 0) {
    return {
      signal    : "empty_context",
      suggestion: "저장된 기억이 없습니다. 작업 후 reflect나 remember로 중요 내용을 저장하세요.",
      trigger   : "remember"
    };
  }
  return null;
}

/**
 * structured=true 전용: anchor 고정 상단 + 나머지 복합 점수 정렬 후 토큰 예산 내 슬라이스.
 * injectionText 중복 제거 목적 — structured 응답에서만 호출된다.
 *
 * @param {object[]} anchorFragments
 * @param {object[]} otherFragments   - core + working (anchor 제외)
 * @param {number}   tokenBudget
 * @param {{ importance: number, ema_activation: number }} weights
 * @returns {{ items: object[], totalTokens: number }}
 */
function buildRankedInjection(anchorFragments, otherFragments, tokenBudget, weights) {
  const { importance: wImp, ema_activation: wEma } = weights;
  const score  = f => (f.importance ?? 0) * wImp + (f.ema_activation ?? 0) * wEma;
  const sorted = [...otherFragments].sort((a, b) => score(b) - score(a));

  const items      = [];
  let   usedTokens = 0;

  for (const f of anchorFragments) {
    usedTokens += Math.ceil((f.content?.length ?? 0) / 4);
    items.push({
      rank      : items.length + 1,
      score     : null,
      id        : f.id,
      type      : f.type,
      content   : f.content,
      importance: f.importance,
      anchor    : true
    });
  }

  for (const f of sorted) {
    const t = Math.ceil((f.content?.length ?? 0) / 4);
    if (usedTokens + t > tokenBudget) break;
    usedTokens += t;
    items.push({
      rank      : items.length + 1,
      score     : +score(f).toFixed(4),
      id        : f.id,
      type      : f.type,
      content   : f.content,
      importance: f.importance,
      anchor    : false
    });
  }

  return { items, totalTokens: usedTokens };
}

function capFragmentsToBudget(fragments, budgetChars) {
  const capped = [];
  let used = 0;

  for (const frag of fragments) {
    const content = frag.content || "";
    const cost = content.length;

    if (used + cost <= budgetChars) {
      capped.push(frag);
      used += cost;
      continue;
    }

    const remaining = budgetChars - used;
    if (remaining > 80) {
      capped.push({
        ...frag,
        content: content.substring(0, remaining - 3) + "..."
      });
    }
    break;
  }

  return capped;
}

function buildCaseSummaryLine(item) {
  const parts = [`${item.case_id} [${item.resolution_status || "open"}]`];
  if (item.goal) parts.push(`goal: ${item.goal}`);
  if (item.outcome) parts.push(`outcome: ${item.outcome}`);
  if (!item.goal && !item.outcome && item.events?.[0]?.summary) {
    parts.push(`hint: ${item.events[0].summary}`);
  }
  return `- ${parts.join(" | ")}`;
}

function buildAuxiliarySectionLines(section) {
  const lines = [];
  if (Array.isArray(section.fragments) && section.fragments.length > 0) {
    for (const frag of section.fragments) {
      lines.push(`- ${frag.content}`);
    }
  } else if (Array.isArray(section.cases) && section.cases.length > 0) {
    for (const item of section.cases) {
      lines.push(buildCaseSummaryLine(item));
    }
  }
  if (lines.length === 0) return [];
  return [`[${section.title}]`, ...lines];
}

export class ContextBuilder {
  #recall;
  #store;
  #index;
  #getPool;
  #hardeningEnabled;
  #auxiliaryPlanner;

  /**
   * @param {{ recall: Function, store: object, index: object, getPool?: Function, hardeningEnabled?: boolean, auxiliaryPlanner?: Function }} deps
   *
   * hardeningEnabled: 신규 기능(Closed Learning Loop, is_anchor 필터) 활성화 여부.
   *   미지정 시 MEMORY_CONFIG.contextInjection.hardeningEnabled 값을 사용 (기본 false).
   *   true → 신규 동작 활성화; false → 명시적 레거시 호환 모드.
   */
  constructor({ recall, store, index, getPool, hardeningEnabled, auxiliaryPlanner }) {
    this.#recall           = recall;
    this.#store            = store;
    this.#index            = index;
    this.#getPool          = getPool || getPrimaryPool;
    this.#hardeningEnabled = hardeningEnabled ?? (MEMORY_CONFIG.contextInjection?.hardeningEnabled === true);
    this.#auxiliaryPlanner = auxiliaryPlanner || planAuxiliarySections;
  }

  async #loadAuxiliarySection(sectionKey, params) {
    const agentId            = params.agentId || "default";
    const keyId              = params._keyId ?? null;
    const groupKeyIds        = params._groupKeyIds ?? (keyId ? [keyId] : null);
    const workspace          = params.workspace ?? params._defaultWorkspace ?? null;
    const auxiliaryBudget    = MEMORY_CONFIG.contextInjection?.auxiliaryTokenBudget || 250;
    const auxiliaryCharBudget = auxiliaryBudget * 4;
    const query              = typeof params.contextText === "string" ? params.contextText.trim() : "";
    const baseRecallParams   = {
      tokenBudget  : auxiliaryBudget,
      minImportance: 0.3,
      excludeSeen  : false,
      agentId,
      _keyId       : keyId,
      _groupKeyIds : groupKeyIds,
      workspace,
      ...(query ? { text: query, contextText: query } : {}),
      ...(params.caseId ? { caseId: params.caseId } : {}),
      ...(params.resolutionStatus ? { resolutionStatus: params.resolutionStatus } : {}),
      ...(params.phase ? { phase: params.phase } : {})
    };

    switch (sectionKey) {
      case "learning_memory": {
        let fragments = [];

        if (query) {
          const result = await this.#recall({
            ...baseRecallParams,
            includeLinks: false,
            source      : "learning_extraction"
          });
          fragments = result.fragments || [];
        }

        if (fragments.length === 0) {
          fragments = await this.#store.searchBySource(
            "learning_extraction",
            agentId,
            groupKeyIds,
            5,
            workspace,
            false,
            {
              ...(params.caseId ? { caseId: params.caseId } : {}),
              ...(params.resolutionStatus ? { resolutionStatus: params.resolutionStatus } : {}),
              ...(params.phase ? { phase: params.phase } : {})
            }
          );
        }

        fragments = capFragmentsToBudget(fragments, auxiliaryCharBudget);
        if (fragments.length === 0) return null;
        return {
          key      : sectionKey,
          title    : AUXILIARY_SECTION_CATALOG[sectionKey].title,
          fragments
        };
      }

      case "error_playbook": {
        const result = await this.#recall({
          ...baseRecallParams,
          type        : "error",
          depth       : "tool-level",
          includeLinks: true
        });
        const fragments = capFragmentsToBudget(result.fragments || [], auxiliaryCharBudget);
        if (fragments.length === 0) return null;
        return {
          key      : sectionKey,
          title    : AUXILIARY_SECTION_CATALOG[sectionKey].title,
          fragments
        };
      }

      case "decision_memory": {
        const result = await this.#recall({
          ...baseRecallParams,
          type        : "decision",
          depth       : "high-level",
          includeLinks: false
        });
        const fragments = capFragmentsToBudget(result.fragments || [], auxiliaryCharBudget);
        if (fragments.length === 0) return null;
        return {
          key      : sectionKey,
          title    : AUXILIARY_SECTION_CATALOG[sectionKey].title,
          fragments
        };
      }

      case "open_questions_memory": {
        const result = await this.#recall({
          ...baseRecallParams,
          topic           : "session_reflect",
          type            : "fact",
          resolutionStatus: "open",
          includeLinks    : false
        });
        const fragments = capFragmentsToBudget(result.fragments || [], auxiliaryCharBudget);
        if (fragments.length === 0) return null;
        return {
          key      : sectionKey,
          title    : AUXILIARY_SECTION_CATALOG[sectionKey].title,
          fragments
        };
      }

      case "case_memory": {
        const result = await this.#recall({
          ...baseRecallParams,
          includeLinks: false,
          caseMode    : true,
          maxCases    : MEMORY_CONFIG.contextInjection?.caseMemoryMaxCases || 2
        });
        const cases     = Array.isArray(result.cases) ? result.cases.slice(0, MEMORY_CONFIG.contextInjection?.caseMemoryMaxCases || 2) : [];
        const fragments = capFragmentsToBudget(result.fragments || [], auxiliaryCharBudget);
        if (cases.length === 0) return null;
        return {
          key      : sectionKey,
          title    : AUXILIARY_SECTION_CATALOG[sectionKey].title,
          cases,
          fragments
        };
      }

      default:
        return null;
    }
  }

  async #buildAuxiliarySections(params, existingIds) {
    if (!this.#hardeningEnabled) return [];

    const plan = await this.#auxiliaryPlanner({
      contextText      : params.contextText,
      caseId           : params.caseId,
      resolutionStatus : params.resolutionStatus,
      phase            : params.phase,
      llmPlannerEnabled: MEMORY_CONFIG.contextInjection?.llmPlannerEnabled !== false,
      maxSections      : MEMORY_CONFIG.contextInjection?.maxAuxiliarySections || 2
    });

    const sections = [];
    for (const sectionKey of plan.sections || []) {
      try {
        const section = await this.#loadAuxiliarySection(sectionKey, params);
        if (!section) continue;

        if (Array.isArray(section.fragments)) {
          section.fragments = section.fragments.filter((frag) => {
            if (!frag?.id || existingIds.has(frag.id)) return false;
            existingIds.add(frag.id);
            return true;
          });
        }

        if ((section.fragments?.length || 0) === 0 && (section.cases?.length || 0) === 0) {
          continue;
        }
        sections.push(section);
      } catch (err) {
        logWarn(`[ContextBuilder] auxiliary section load failed (${sectionKey}): ${err.message}`);
      }
    }

    return sections;
  }

  /**
   * 컨텍스트를 조합하여 반환한다.
   * MemoryManager.context()와 동일한 시그니처 및 반환값.
   *
   * @param {Object} params
   *   - sessionId   {string} 세션 ID (선택)
   *   - tokenBudget {number} 기본 2000
   *   - types       {string[]} 로드할 유형 목록 (기본: preference, error, procedure)
   *   - contextText {string} 현재 user 질의/대화 맥락. hardening=true면 learning_extraction query-aware attach에 사용
   *   - caseId      {string} 특정 케이스 컨텍스트 필터
   *   - resolutionStatus {string} open|resolved|abandoned 필터
   *   - phase       {string} planning|debugging|verification 등 단계 필터
   *   - structured  {boolean} 계층적 트리 구조 반환 여부
   * @returns {Object} { fragments, totalTokens, injectionText, coreTokens, wmTokens, wmCount }
   */
  async build(params) {
    const types           = [...(params.types || ["preference", "error", "procedure", "decision"])];
    const coreBudget      = 1500;
    const wmBudget        = 800;
    const coreCharBudget  = coreBudget * 4;

    /** -- Core Memory 로드 (앵커 제외) -- */
    const typeFragMap   = new Map();
    const agentId       = params.agentId || "default";
    const keyId         = params._keyId ?? null;
    const groupKeyIds   = params._groupKeyIds ?? (keyId ? [keyId] : null);
    const workspace     = params.workspace ?? params._defaultWorkspace ?? null;

    /** types 배열을 병렬 recall로 처리 (N+1 순차 제거) */
    await Promise.all(types.map(async type => {
      const result = await this.#recall({
        type,
        tokenBudget : Math.max(250, Math.floor(coreBudget / types.length)),
        minImportance: 0.3,
        isAnchor    : false,
        agentId,
        _keyId      : keyId,
        _groupKeyIds: groupKeyIds,
        workspace
      });
      typeFragMap.set(type, result.fragments);
    }));

    /** -- session_reflect 파편 별도 로드 (직전 세션 요약, 최신순 상위) -- */
    {
      const reflectResult = await this.#recall({
        topic       : "session_reflect",
        tokenBudget : 300,
        minImportance: 0.3,
        isAnchor    : false,
        agentId,
        _keyId      : keyId,
        _groupKeyIds: groupKeyIds,
        workspace
      });
      if (reflectResult.fragments.length > 0) {
        typeFragMap.set("session_reflect", reflectResult.fragments);
        types.push("session_reflect");
      }
    }

    if (this.#hardeningEnabled) {
      for (const [type, frags] of typeFragMap.entries()) {
        typeFragMap.set(type, (frags || []).filter(f => f.source !== "learning_extraction"));
      }
    }

    const guaranteed = new Map();
    const seen       = new Set();
    let usedChars    = 0;

    for (const type of types) {
      const frags = typeFragMap.get(type) || [];
      if (frags.length > 0) {
        const top     = frags[0];
        const content = top.content || "";
        guaranteed.set(type, [top]);
        seen.add(top.id);
        usedChars += content.length;
      }
    }

    const extras = [];
    for (const type of types) {
      const frags = typeFragMap.get(type) || [];
      for (let i = 1; i < frags.length; i++) {
        if (!seen.has(frags[i].id)) {
          extras.push(frags[i]);
          seen.add(frags[i].id);
        }
      }
    }
    const tempBoost     = MEMORY_CONFIG.contextInjection?.temperatureBoost || {};
    const warmMs        = (tempBoost.warmWindowDays || 7) * 86400000;
    const accessThresh  = tempBoost.highAccessThreshold || 5;
    const _now          = Date.now();

    function _tempScore(frag) {
      let score = frag.importance || 0;
      const accessedAt = frag.accessed_at ? new Date(frag.accessed_at).getTime() : 0;
      if (_now - accessedAt < warmMs) score += tempBoost.warmBoost || 0;
      if ((frag.access_count || 0) >= accessThresh) score += tempBoost.highAccessBoost || 0;
      if (frag.source === "learning_extraction") score += tempBoost.learningBoost || 0;
      return score;
    }

    extras.sort((a, b) => _tempScore(b) - _tempScore(a));

    /** 스마트 캡: 파편 수 상한 + 유형별 슬롯 제한 */
    const maxCore      = MEMORY_CONFIG.contextInjection?.maxCoreFragments || 15;
    const typeSlots    = MEMORY_CONFIG.contextInjection?.typeSlots || {};
    let   totalAdded   = 0;
    for (const [, frags] of guaranteed) {
      totalAdded += frags.length;
    }

    const typeCounters = {};
    for (const [type, frags] of guaranteed) {
      typeCounters[type] = frags.length;
    }

    for (const f of extras) {
      if (totalAdded >= maxCore) break;

      const typeKey  = f.type || "general";
      const typeMax  = typeSlots[typeKey] || 5;
      const current  = typeCounters[typeKey] || 0;
      if (current >= typeMax) continue;

      const cost = (f.content || "").length;
      if (usedChars + cost > coreCharBudget) {
        const remaining = coreCharBudget - usedChars;
        if (remaining > 80) {
          const truncated = { ...f, content: f.content.substring(0, remaining - 3) + "..." };
          const typeArr   = guaranteed.get(typeKey) || [];
          typeArr.push(truncated);
          guaranteed.set(typeKey, typeArr);
          usedChars += remaining;
          typeCounters[typeKey] = (typeCounters[typeKey] || 0) + 1;
          totalAdded++;
        }
        break;
      }

      const typeArr = guaranteed.get(typeKey) || [];
      typeArr.push(f);
      guaranteed.set(typeKey, typeArr);
      usedChars += cost;
      typeCounters[typeKey] = (typeCounters[typeKey] || 0) + 1;
      totalAdded++;
    }

    const coreFragments = [];
    for (const type of types) {
      const frags = guaranteed.get(type) || [];
      coreFragments.push(...frags);
    }

    /** -- Working Memory 로드 (Redis, 최신순, 앵커 제외) -- */
    let wmFragments = [];
    let wmChars     = 0;

    if (params.sessionId) {
      const wmItems      = (await this.#index.getWorkingMemory(params.sessionId)).reverse();
      const wmCharBudget = wmBudget * 4;
      const maxWm        = MEMORY_CONFIG.contextInjection?.maxWmFragments || 10;

      for (const item of wmItems) {
        if (item.is_anchor) continue;
        if (wmFragments.length >= maxWm) break;
        const cost = (item.content || "").length;
        if (wmChars + cost > wmCharBudget) break;
        wmFragments.push(item);
        wmChars += cost;
      }
    }

    /** -- Anchor Memory 로드 (중요도 순 상위 10개, 항상 포함) -- */
    let anchorFragments = [];
    try {
      const pool = this.#getPool();
      if (pool) {
        const anchorParams    = [];
        let   anchorKeyFilter = "";
        let   anchorWorkspaceFilter = "";
        if (groupKeyIds != null) {
          anchorParams.push(groupKeyIds);
          anchorKeyFilter = `AND key_id = ANY($${anchorParams.length})`;
        }
        anchorParams.push(workspace);
        anchorWorkspaceFilter = `AND ($${anchorParams.length}::text IS NULL OR workspace = $${anchorParams.length} OR workspace IS NULL)`;
        const anchorResult = await pool.query(
          `SELECT id, content, type, topic, importance, TRUE AS is_anchor
             FROM agent_memory.fragments
            WHERE is_anchor = TRUE
              AND valid_to IS NULL
              ${anchorKeyFilter}
              ${anchorWorkspaceFilter}
            ORDER BY importance DESC
            LIMIT 10`,
          anchorParams
        );
        anchorFragments = anchorResult.rows;
      }
    } catch (err) {
      logWarn(`[ContextBuilder] anchor load failed: ${err.message}`);
    }

    const existingIds = new Set(
      [...anchorFragments, ...coreFragments, ...wmFragments]
        .map(f => f.id)
        .filter(Boolean)
    );
    const auxiliarySections = await this.#buildAuxiliarySections(params, existingIds);
    const auxiliaryFragments = auxiliarySections.flatMap(section => section.fragments || []);

    /** -- 주입용 텍스트 생성 (Anchor + Core + WM 분리) -- */
    const lines = [];

    if (anchorFragments.length > 0) {
      lines.push("[ANCHOR MEMORY]");
      for (const f of anchorFragments) {
        lines.push(`- ${f.content}`);
      }
    }

    const coreSections = {};
    for (const f of coreFragments) {
      const key = f.type || "general";
      if (!coreSections[key]) coreSections[key] = [];
      coreSections[key].push(f.content);
    }

    if (Object.keys(coreSections).length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push("[CORE MEMORY]");
      for (const [type, contents] of Object.entries(coreSections)) {
        lines.push(`[${type.toUpperCase()}]`);
        for (const c of contents) {
          lines.push(`- ${c}`);
        }
      }
    }

    for (const section of auxiliarySections) {
      const sectionLines = buildAuxiliarySectionLines(section);
      if (sectionLines.length === 0) continue;
      if (lines.length > 0) lines.push("");
      lines.push(...sectionLines);
    }

    if (wmFragments.length > 0) {
      lines.push("");
      lines.push("[WORKING MEMORY]");
      for (const wm of wmFragments) {
        const label = wm.type ? `[${wm.type.toUpperCase()}]` : "";
        lines.push(`- ${label} ${wm.content}`);
      }
    }

    /** 미반영(unreflected) 세션 감지 힌트 */
    try {
      const { SessionActivityTracker } = await import("./SessionActivityTracker.js");
      const unreflected = await SessionActivityTracker.getUnreflectedSessions(3);
      if (unreflected.length > 0) {
        lines.push("");
        lines.push("[SYSTEM HINT]");
        lines.push(`- 미반영 세션 ${unreflected.length}개 감지. 세션 종료 전 reflect()를 호출하면 학습 내용이 보존됩니다.`);
      }
    } catch { /* 무시 */ }

    const anchorChars  = anchorFragments.reduce((s, f) => s + (f.content || "").length, 0);
    const auxiliaryChars = auxiliaryFragments.reduce((s, f) => s + (f.content || "").length, 0);
    const coreTokens   = Math.ceil(usedChars / 4);
    const auxiliaryTokens = Math.ceil(auxiliaryChars / 4);
    const wmTokens     = Math.ceil(wmChars / 4);
    const anchorTokens = Math.ceil(anchorChars / 4);

    /** -- 중복 제거: 동일 ID 파편은 첫 등장만 유지 -- */
    const allFragments = [...anchorFragments, ...coreFragments, ...auxiliaryFragments, ...wmFragments];
    const dedupSeen    = new Set();
    const dedupResult  = [];
    for (const f of allFragments) {
      if (f.id && dedupSeen.has(f.id)) continue;
      if (f.id) dedupSeen.add(f.id);
      dedupResult.push(f);
    }

    /** -- Seen IDs 저장: recall() 중복 주입 방지용 -- */
    if (params.sessionId) {
      const seenIds = dedupResult.map(f => f.id).filter(Boolean);
      await this.#index.setSeenIds(params.sessionId, seenIds);
    }

    /** -- structured=true: 계층적 트리 구조 반환 -- */
    if (params.structured === true) {
      const coreByType = {};
      for (const f of coreFragments) {
        const key = f.type || "general";
        if (!coreByType[key]) coreByType[key] = [];
        coreByType[key].push(f);
      }
      const learningFragments = auxiliarySections.find(section => section.key === "learning_memory")?.fragments || [];
      const errorPlaybook = auxiliarySections.find(section => section.key === "error_playbook")?.fragments || [];
      const decisionMemory = auxiliarySections.find(section => section.key === "decision_memory")?.fragments || [];
      const openQuestionsMemory = auxiliarySections.find(section => section.key === "open_questions_memory")?.fragments || [];
      const caseMemory = auxiliarySections.find(section => section.key === "case_memory")?.cases || [];

      const contextHint  = buildContextHint(dedupResult);
      const rankWeights  = MEMORY_CONFIG.contextInjection.rankWeights;
      // hardening=true: is_anchor 필드 기반(정확). hardening=false: 기존 동작 유지(type==="anchor"는 항상 빈 배열이었음).
      const anchorFrags  = this.#hardeningEnabled
        ? dedupResult.filter(f => f.is_anchor === true)
        : dedupResult.filter(f => f.type === "anchor");
      const otherFrags   = this.#hardeningEnabled
        ? dedupResult.filter(f => f.is_anchor !== true)
        : dedupResult.filter(f => f.type !== "anchor");
      const ranked       = buildRankedInjection(
        anchorFrags, otherFrags,
        params.tokenBudget ?? MEMORY_CONFIG.contextInjection.defaultTokenBudget,
        rankWeights
      );

      return {
        success         : true,
        structured      : true,
        core            : {
          preferences: coreByType.preference || [],
          errors     : coreByType.error      || [],
          decisions  : coreByType.decision   || [],
          procedures : coreByType.procedure  || [],
          ...Object.fromEntries(
            Object.entries(coreByType)
              .filter(([k]) => !["preference", "error", "decision", "procedure"].includes(k))
          )
        },
        working         : {
          current_session: wmFragments
        },
        anchors         : {
          permanent: anchorFragments
        },
        learning        : {
          recent: learningFragments
        },
        auxiliary       : {
          errorPlaybook,
          decisionMemory,
          openQuestionsMemory,
          caseMemory
        },
        totalTokens     : anchorTokens + coreTokens + auxiliaryTokens + wmTokens,
        count           : dedupResult.length,
        anchorTokens,
        coreTokens,
        auxiliaryTokens,
        wmTokens,
        wmCount         : wmFragments.length,
        anchorCount     : anchorFragments.length,
        rankedInjection : ranked,
        ...(contextHint ? { _memento_hint: contextHint } : {})
      };
    }

    const contextHint = buildContextHint(dedupResult);
    return {
      fragments    : dedupResult,
      totalTokens  : anchorTokens + coreTokens + auxiliaryTokens + wmTokens,
      count        : dedupResult.length,
      anchorTokens,
      coreTokens,
      auxiliaryTokens,
      wmTokens,
      wmCount      : wmFragments.length,
      anchorCount  : anchorFragments.length,
      injectionText: lines.join("\n"),
      ...(contextHint ? { _memento_hint: contextHint } : {})
    };
  }
}

/* 단위 테스트용 export */
export { buildContextHint, buildRankedInjection };
