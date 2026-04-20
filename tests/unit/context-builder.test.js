/**
 * ContextBuilder 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-05
 *
 * recall을 mock하여 ContextBuilder.build()의 Core/WM/Anchor 조합,
 * 중복 제거, structured 모드, 힌트 생성을 검증한다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { ContextBuilder, buildContextHint, buildRankedInjection } from "../../lib/memory/ContextBuilder.js";

/* ── 헬퍼: 파편 팩토리 ── */
function frag(id, type, content, extra = {}) {
  return { id, type, content, importance: 0.5, ...extra };
}

/* ── buildContextHint 단위 테스트 ── */
describe("buildContextHint", () => {
  it("error 파편이 있으면 active_errors 힌트 반환", () => {
    const hint = buildContextHint([frag("1", "error", "err"), frag("2", "fact", "ok")]);
    assert.equal(hint.signal, "active_errors");
    assert.equal(hint.trigger, "forget");
  });

  it("파편이 비어 있으면 empty_context 힌트 반환", () => {
    const hint = buildContextHint([]);
    assert.equal(hint.signal, "empty_context");
    assert.equal(hint.trigger, "remember");
  });

  it("error 없고 파편 존재 시 null 반환", () => {
    const hint = buildContextHint([frag("1", "fact", "ok")]);
    assert.equal(hint, null);
  });
});

/* ── buildRankedInjection 단위 테스트 ── */
describe("buildRankedInjection", () => {
  const weights = { importance: 1.0, ema_activation: 0.5 };

  it("anchor를 상단에 고정하고 나머지를 점수순 정렬", () => {
    const anchors = [frag("a1", "anchor", "anchor text", { importance: 1.0 })];
    const others  = [
      frag("o1", "fact", "low", { importance: 0.2, ema_activation: 0 }),
      frag("o2", "fact", "high", { importance: 0.9, ema_activation: 0.5 }),
    ];
    const result = buildRankedInjection(anchors, others, 2000, weights);
    assert.equal(result.items[0].anchor, true);
    assert.equal(result.items[0].id, "a1");
    assert.equal(result.items[1].id, "o2");
    assert.equal(result.items[2].id, "o1");
  });

  it("토큰 예산 초과 시 잘림", () => {
    const anchors = [];
    const others  = [
      frag("o1", "fact", "a".repeat(400), { importance: 0.9 }),
      frag("o2", "fact", "b".repeat(400), { importance: 0.5 }),
    ];
    const result = buildRankedInjection(anchors, others, 100, weights);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].id, "o1");
  });
});

/* ── ContextBuilder.build() 통합 테스트 ── */
describe("ContextBuilder.build()", () => {
  let recallMock;
  let indexMock;
  let storeMock;
  let auxiliaryPlannerMock;
  let builder;

  beforeEach(() => {
    recallMock = mock.fn(async (params) => {
      if (params.topic === "session_reflect") {
        return { fragments: [] };
      }
      return {
        fragments: [
          frag(`${params.type}-1`, params.type, `${params.type} content 1`),
          frag(`${params.type}-2`, params.type, `${params.type} content 2`),
        ]
      };
    });

    indexMock = {
      getWorkingMemory: mock.fn(async () => []),
      setSeenIds      : mock.fn(async () => {}),
    };

    storeMock = {
      searchBySource: mock.fn(async () => []),
    };

    auxiliaryPlannerMock = mock.fn(async () => ({ sections: [] }));

    builder = new ContextBuilder({
      recall          : recallMock,
      store           : storeMock,
      index           : indexMock,
      getPool         : () => null,
      auxiliaryPlanner: auxiliaryPlannerMock,
    });
  });

  it("기본 types로 recall을 호출하고 fragments를 반환", async () => {
    const result = await builder.build({});

    assert.ok(Array.isArray(result.fragments));
    assert.ok(result.fragments.length > 0);
    assert.equal(typeof result.totalTokens, "number");
    assert.equal(typeof result.injectionText, "string");
    assert.equal(typeof result.coreTokens, "number");
    assert.equal(typeof result.wmTokens, "number");
    assert.equal(typeof result.wmCount, "number");
    assert.equal(typeof result.anchorCount, "number");
  });

  it("recall을 types 수 + session_reflect 1회 호출", async () => {
    await builder.build({ types: ["error", "preference"] });
    /** error, preference + session_reflect = 3회 */
    assert.equal(recallMock.mock.callCount(), 3);
  });

  it("sessionId 전달 시 working memory를 로드하고 seenIds 저장", async () => {
    indexMock.getWorkingMemory = mock.fn(async () => [
      { id: "wm-1", content: "wm item", type: "fact" }
    ]);

    const result = await builder.build({ sessionId: "sess-1" });

    assert.equal(indexMock.getWorkingMemory.mock.callCount(), 1);
    assert.equal(indexMock.setSeenIds.mock.callCount(), 1);
    assert.equal(result.wmCount, 1);
  });

  it("중복 ID 파편은 첫 등장만 유지", async () => {
    recallMock = mock.fn(async (params) => {
      if (params.topic === "session_reflect") return { fragments: [] };
      return {
        fragments: [frag("dup-1", params.type, `${params.type} content`)]
      };
    });
    builder = new ContextBuilder({
      recall          : recallMock,
      store           : storeMock,
      index           : indexMock,
      getPool         : () => null,
      auxiliaryPlanner: auxiliaryPlannerMock,
    });

    const result = await builder.build({ types: ["error", "preference"] });
    const ids    = result.fragments.map(f => f.id);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size);
  });

  it("structured=true 시 계층적 트리 구조 반환", async () => {
    const result = await builder.build({ structured: true });

    assert.equal(result.success, true);
    assert.equal(result.structured, true);
    assert.ok(result.core);
    assert.ok(result.working);
    assert.ok(result.anchors);
    assert.ok(result.learning);
    assert.ok(result.rankedInjection);
    assert.equal(typeof result.count, "number");
  });

  it("learning 파편이 flat injectionText와 fragments에 포함된다 (hardening=true)", async () => {
    storeMock.searchBySource = mock.fn(async () => [
      frag("learn-1", "fact", "learning content", { source: "learning_extraction" })
    ]);
    auxiliaryPlannerMock = mock.fn(async () => ({ sections: ["learning_memory"] }));
    builder = new ContextBuilder({
      recall          : recallMock,
      store           : storeMock,
      index           : indexMock,
      getPool         : () => null,
      hardeningEnabled: true,
      auxiliaryPlanner: auxiliaryPlannerMock,
    });

    const result = await builder.build({});

    assert.ok(result.fragments.some(f => f.id === "learn-1"));
    assert.match(result.injectionText, /\[LEARNING MEMORY\]/);
    assert.match(result.injectionText, /learning content/);
  });

  it("hardening=true + contextText가 있으면 learning_extraction을 query-aware recall로 먼저 붙인다", async () => {
    recallMock = mock.fn(async (params) => {
      if (params.topic === "session_reflect") {
        return { fragments: [] };
      }
      if (params.source === "learning_extraction") {
        return {
          fragments: [
            frag("learn-query-1", "fact", "query matched learning", { source: "learning_extraction" })
          ]
        };
      }
      return {
        fragments: [
          frag(`${params.type}-1`, params.type, `${params.type} content 1`),
          frag(`${params.type}-2`, params.type, `${params.type} content 2`),
        ]
      };
    });
    storeMock.searchBySource = mock.fn(async () => [
      frag("learn-fallback", "fact", "fallback learning", { source: "learning_extraction" })
    ]);
    auxiliaryPlannerMock = mock.fn(async () => ({ sections: ["learning_memory"] }));
    builder = new ContextBuilder({
      recall          : recallMock,
      store           : storeMock,
      index           : indexMock,
      getPool         : () => null,
      hardeningEnabled: true,
      auxiliaryPlanner: auxiliaryPlannerMock,
    });

    const result = await builder.build({
      contextText     : "현재 user 질의",
      caseId          : "case-123",
      resolutionStatus: "open",
      phase           : "debugging"
    });

    assert.ok(result.fragments.some(f => f.id === "learn-query-1"));
    assert.equal(storeMock.searchBySource.mock.callCount(), 0);

    const learningCall = recallMock.mock.calls.find(call => call.arguments[0].source === "learning_extraction");
    assert.ok(learningCall);
    assert.equal(learningCall.arguments[0].text, "현재 user 질의");
    assert.equal(learningCall.arguments[0].contextText, "현재 user 질의");
    assert.equal(learningCall.arguments[0].caseId, "case-123");
    assert.equal(learningCall.arguments[0].resolutionStatus, "open");
    assert.equal(learningCall.arguments[0].phase, "debugging");
    assert.equal(learningCall.arguments[0].includeLinks, false);
  });

  it("query-aware learning recall 결과가 없으면 source fallback으로 최근 learning을 붙인다", async () => {
    recallMock = mock.fn(async (params) => {
      if (params.topic === "session_reflect") {
        return { fragments: [] };
      }
      if (params.source === "learning_extraction") {
        return { fragments: [] };
      }
      return {
        fragments: [
          frag(`${params.type}-1`, params.type, `${params.type} content 1`),
          frag(`${params.type}-2`, params.type, `${params.type} content 2`),
        ]
      };
    });
    storeMock.searchBySource = mock.fn(async () => [
      frag("learn-fallback-1", "fact", "fallback learning", {
        source           : "learning_extraction",
        case_id          : "case-123",
        resolution_status: "open",
        phase            : "debugging"
      })
    ]);
    auxiliaryPlannerMock = mock.fn(async () => ({ sections: ["learning_memory"] }));
    builder = new ContextBuilder({
      recall          : recallMock,
      store           : storeMock,
      index           : indexMock,
      getPool         : () => null,
      hardeningEnabled: true,
      auxiliaryPlanner: auxiliaryPlannerMock,
    });

    const result = await builder.build({
      contextText     : "현재 user 질의",
      caseId          : "case-123",
      resolutionStatus: "open",
      phase           : "debugging",
      _keyId          : "key-1",
      _groupKeyIds    : ["key-1", "key-2"]
    });

    assert.equal(storeMock.searchBySource.mock.callCount(), 1);
    assert.deepEqual(storeMock.searchBySource.mock.calls[0].arguments.slice(0, 5), [
      "learning_extraction",
      "default",
      ["key-1", "key-2"],
      5,
      null
    ]);
    assert.equal(storeMock.searchBySource.mock.calls[0].arguments[5], false);
    assert.deepEqual(storeMock.searchBySource.mock.calls[0].arguments[6], {
      caseId          : "case-123",
      resolutionStatus: "open",
      phase           : "debugging"
    });
    assert.ok(result.fragments.some(f => f.id === "learn-fallback-1"));
    assert.match(result.injectionText, /fallback learning/);
  });

  it("hardening=false(명시적 호환 모드)에서는 learning 파편을 주입하지 않는다", async () => {
    storeMock.searchBySource = mock.fn(async () => [
      frag("learn-default", "fact", "default learning content", { source: "learning_extraction" })
    ]);
    builder = new ContextBuilder({
      recall          : recallMock,
      store           : storeMock,
      index           : indexMock,
      getPool         : () => null,
      hardeningEnabled: false,
      auxiliaryPlanner: auxiliaryPlannerMock,
    });

    const result = await builder.build({});

    assert.equal(storeMock.searchBySource.mock.callCount(), 0);
    assert.ok(!result.fragments.some(f => f.id === "learn-default"));
    assert.doesNotMatch(result.injectionText, /\[LEARNING MEMORY\]/);
    assert.doesNotMatch(result.injectionText, /default learning content/);
  });

  it("hardening=false 에서 recall 경로의 learning_extraction 파편은 core memory에 유지된다", async () => {
    recallMock = mock.fn(async (params) => {
      if (params.topic === "session_reflect") {
        return { fragments: [] };
      }
      if (params.type === "fact") {
        return {
          fragments: [
            frag("fact-learning-1", "fact", "legacy learning fact", { source: "learning_extraction" }),
          ],
        };
      }
      return { fragments: [] };
    });
    builder = new ContextBuilder({
      recall          : recallMock,
      store           : storeMock,
      index           : indexMock,
      getPool         : () => null,
      hardeningEnabled: false,
    });

    const flatResult = await builder.build({ types: ["fact"] });
    assert.ok(flatResult.fragments.some(f => f.id === "fact-learning-1"));
    assert.match(flatResult.injectionText, /\[CORE MEMORY\]/);
    assert.match(flatResult.injectionText, /\[FACT\]/);
    assert.match(flatResult.injectionText, /legacy learning fact/);
    assert.doesNotMatch(flatResult.injectionText, /\[LEARNING MEMORY\]/);

    const structuredResult = await builder.build({ types: ["fact"], structured: true });
    assert.equal(structuredResult.core.fact.length, 1);
    assert.equal(structuredResult.core.fact[0].id, "fact-learning-1");
  });

  it("structured=true 시 learning 파편이 rankedInjection에는 포함되고 core 중복 분류는 되지 않는다 (hardening=true)", async () => {
    storeMock.searchBySource = mock.fn(async () => [
      frag("learn-1", "fact", "learning content", { source: "learning_extraction", importance: 0.95 })
    ]);
    auxiliaryPlannerMock = mock.fn(async () => ({ sections: ["learning_memory"] }));
    builder = new ContextBuilder({
      recall          : recallMock,
      store           : storeMock,
      index           : indexMock,
      getPool         : () => null,
      hardeningEnabled: true,
      auxiliaryPlanner: auxiliaryPlannerMock,
    });

    const result = await builder.build({ structured: true });

    assert.equal(result.learning.recent.length, 1);
    assert.equal(result.learning.recent[0].id, "learn-1");
    assert.ok(result.rankedInjection.items.some(item => item.id === "learn-1"));
    assert.ok(!(result.core.fact || []).some(f => f.id === "learn-1"));
  });

  it("hardening=true 에서 learning 파편 여러 개가 fragments와 rankedInjection에 모두 유지된다", async () => {
    storeMock.searchBySource = mock.fn(async () => [
      frag("learn-1", "fact", "learning content 1", { source: "learning_extraction", importance: 0.95 }),
      frag("learn-2", "fact", "learning content 2", { source: "learning_extraction", importance: 0.9 }),
    ]);
    auxiliaryPlannerMock = mock.fn(async () => ({ sections: ["learning_memory"] }));
    builder = new ContextBuilder({
      recall          : recallMock,
      store           : storeMock,
      index           : indexMock,
      getPool         : () => null,
      hardeningEnabled: true,
      auxiliaryPlanner: auxiliaryPlannerMock,
    });

    const flatResult = await builder.build({});
    assert.ok(flatResult.fragments.some(f => f.id === "learn-1"));
    assert.ok(flatResult.fragments.some(f => f.id === "learn-2"));

    const structuredResult = await builder.build({ structured: true });
    assert.equal(structuredResult.learning.recent.length, 2);
    assert.ok(structuredResult.rankedInjection.items.some(item => item.id === "learn-1"));
    assert.ok(structuredResult.rankedInjection.items.some(item => item.id === "learn-2"));
  });

  it("hardening=true 에서 보조 섹션 예산을 넘는 learning 파편은 뒤쪽 항목이 잘린다", async () => {
    storeMock.searchBySource = mock.fn(async () => [
      frag("learn-big-1", "fact", "a".repeat(4000), { source: "learning_extraction", importance: 0.95 }),
      frag("learn-big-2", "fact", "b".repeat(4000), { source: "learning_extraction", importance: 0.9 }),
    ]);
    auxiliaryPlannerMock = mock.fn(async () => ({ sections: ["learning_memory"] }));
    builder = new ContextBuilder({
      recall          : recallMock,
      store           : storeMock,
      index           : indexMock,
      getPool         : () => null,
      hardeningEnabled: true,
      auxiliaryPlanner: auxiliaryPlannerMock,
    });

    const flatResult = await builder.build({});
    assert.ok(flatResult.fragments.some(f => f.id === "learn-big-1"));
    assert.ok(!flatResult.fragments.some(f => f.id === "learn-big-2"));
    assert.match(flatResult.injectionText, /a{20}/);
    assert.doesNotMatch(flatResult.injectionText, /b{20}/);

    const structuredResult = await builder.build({ structured: true });
    assert.equal(structuredResult.learning.recent.length, 1);
    assert.equal(structuredResult.learning.recent[0].id, "learn-big-1");
    assert.ok(structuredResult.learning.recent[0].content.length < 4000);
    assert.match(structuredResult.learning.recent[0].content, /\.\.\.$/);
  });

  it("anchor query에 workspace 필터를 적용하고 rankedInjection에서 anchor로 고정한다 (hardening=true)", async () => {
    const poolMock = {
      query: mock.fn(async () => ({
        rows: [frag("anchor-1", "decision", "anchor content", { is_anchor: true, importance: 1.0 })]
      }))
    };
    builder = new ContextBuilder({
      recall          : recallMock,
      store           : storeMock,
      index           : indexMock,
      getPool         : () => poolMock,
      hardeningEnabled: true,
      auxiliaryPlanner: auxiliaryPlannerMock,
    });

    const result = await builder.build({ structured: true, workspace: "maker" });

    assert.equal(poolMock.query.mock.callCount(), 1);
    const [sql, params] = poolMock.query.mock.calls[0].arguments;
    assert.match(sql, /workspace = \$\d+ OR workspace IS NULL/);
    assert.deepEqual(params, ["maker"]);
    assert.equal(result.rankedInjection.items[0].id, "anchor-1");
    assert.equal(result.rankedInjection.items[0].anchor, true);
  });

  it("planner가 선택한 error/decision 보조 섹션만 추가로 붙인다", async () => {
    recallMock = mock.fn(async (params) => {
      if (params.topic === "session_reflect") return { fragments: [] };
      if (params.type === "error" && params.text) {
        return { fragments: [frag("err-aux-1", "error", "targeted error playbook")] };
      }
      if (params.type === "decision" && params.text) {
        return { fragments: [frag("dec-aux-1", "decision", "targeted decision memory")] };
      }
      return {
        fragments: [
          frag(`${params.type}-1`, params.type, `${params.type} content 1`),
          frag(`${params.type}-2`, params.type, `${params.type} content 2`),
        ]
      };
    });
    auxiliaryPlannerMock = mock.fn(async () => ({
      sections: ["error_playbook", "decision_memory"]
    }));
    builder = new ContextBuilder({
      recall          : recallMock,
      store           : storeMock,
      index           : indexMock,
      getPool         : () => null,
      hardeningEnabled: true,
      auxiliaryPlanner: auxiliaryPlannerMock,
    });

    const flatResult = await builder.build({
      contextText: "현재 에러 원인과 설계 결정을 같이 보고 싶다"
    });

    assert.match(flatResult.injectionText, /\[ERROR PLAYBOOK\]/);
    assert.match(flatResult.injectionText, /targeted error playbook/);
    assert.match(flatResult.injectionText, /\[DECISION MEMORY\]/);
    assert.match(flatResult.injectionText, /targeted decision memory/);

    const structuredResult = await builder.build({
      contextText: "현재 에러 원인과 설계 결정을 같이 보고 싶다",
      structured : true
    });
    assert.equal(structuredResult.auxiliary.errorPlaybook.length, 1);
    assert.equal(structuredResult.auxiliary.decisionMemory.length, 1);
  });

  it("파편이 비어 있으면 _memento_hint에 empty_context 포함", async () => {
    recallMock = mock.fn(async () => ({ fragments: [] }));
    builder    = new ContextBuilder({
      recall          : recallMock,
      store           : storeMock,
      index           : indexMock,
      getPool         : () => null,
      auxiliaryPlanner: auxiliaryPlannerMock,
    });

    const result = await builder.build({});
    assert.ok(result._memento_hint);
    assert.equal(result._memento_hint.signal, "empty_context");
  });

  it("error 파편 존재 시 _memento_hint에 active_errors 포함", async () => {
    recallMock = mock.fn(async (params) => {
      if (params.topic === "session_reflect") return { fragments: [] };
      if (params.type === "error") {
        return { fragments: [frag("err-1", "error", "some error")] };
      }
      return { fragments: [] };
    });
    builder = new ContextBuilder({
      recall          : recallMock,
      store           : storeMock,
      index           : indexMock,
      getPool         : () => null,
      auxiliaryPlanner: auxiliaryPlannerMock,
    });

    const result = await builder.build({});
    assert.ok(result._memento_hint);
    assert.equal(result._memento_hint.signal, "active_errors");
  });

  /* ── hardening=false 회귀 테스트 (명시적 레거시 호환 모드 검증) ── */

  it("hardening=false(명시적 호환 모드): searchBySource를 호출하지 않는다", async () => {
    storeMock.searchBySource = mock.fn(async () => [
      frag("learn-1", "fact", "should not appear")
    ]);
    builder = new ContextBuilder({
      recall          : recallMock,
      store           : storeMock,
      index           : indexMock,
      getPool         : () => null,
      hardeningEnabled: false,
      auxiliaryPlanner: auxiliaryPlannerMock,
    });

    await builder.build({});
    assert.equal(storeMock.searchBySource.mock.callCount(), 0);
  });

  it("hardening=false: injectionText에 [LEARNING MEMORY]가 없다", async () => {
    storeMock.searchBySource = mock.fn(async () => [
      frag("learn-1", "fact", "learning content")
    ]);
    builder = new ContextBuilder({
      recall          : recallMock,
      store           : storeMock,
      index           : indexMock,
      getPool         : () => null,
      hardeningEnabled: false,
      auxiliaryPlanner: auxiliaryPlannerMock,
    });

    const result = await builder.build({});
    assert.ok(!result.injectionText.includes("[LEARNING MEMORY]"));
    assert.ok(!result.fragments.some(f => f.id === "learn-1"));
  });

  it("hardening=false: is_anchor=true 파편이 있어도 rankedInjection에서 anchor로 고정되지 않는다", async () => {
    const poolMock = {
      query: mock.fn(async () => ({
        rows: [frag("anchor-1", "decision", "anchor content", { is_anchor: true, importance: 1.0 })]
      }))
    };
    builder = new ContextBuilder({
      recall          : recallMock,
      store           : storeMock,
      index           : indexMock,
      getPool         : () => poolMock,
      hardeningEnabled: false,
      auxiliaryPlanner: auxiliaryPlannerMock,
    });

    const result = await builder.build({ structured: true, workspace: "maker" });
    // legacy 필터(f.type === "anchor")는 항상 빈 배열 → 첫 항목은 anchor:false
    assert.ok(result.rankedInjection.items.length > 0);
    assert.equal(result.rankedInjection.items[0].anchor, false);
  });

  it("hardening=false: 기본 recall 동작과 fragments 반환은 hardening=true와 동일하다", async () => {
    const builderOff = new ContextBuilder({
      recall: recallMock, store: storeMock, index: indexMock, getPool: () => null, hardeningEnabled: false, auxiliaryPlanner: auxiliaryPlannerMock,
    });
    const builderOn = new ContextBuilder({
      recall: recallMock, store: storeMock, index: indexMock, getPool: () => null, hardeningEnabled: true, auxiliaryPlanner: auxiliaryPlannerMock,
    });

    const off = await builderOff.build({});
    const on  = await builderOn.build({});
    // learning이 없는 환경에서는 fragments 수가 동일해야 한다
    assert.equal(off.fragments.length, on.fragments.length);
    assert.equal(off.wmCount, on.wmCount);
  });
});
