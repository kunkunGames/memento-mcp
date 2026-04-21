/**
 * H1 응답 메타 통일 (_meta 래퍼) 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 *
 * tool_recall 및 tool_context 핸들러의 _meta 래핑 로직을
 * DB 의존성 없이 인라인 재현하여 검증한다.
 *
 * 검증 항목:
 *  1. recall 일반 응답: top-level _searchEventId 와 _meta.searchEventId 값 일치
 *  2. recall caseMode 응답: _meta 필드 포함 여부
 *  3. context 응답: _meta.searchEventId=null, _meta.hints 포함
 *  4. _suggestion 이 _meta.suggestion 으로 반영
 *  5. hint 없으면 _meta.hints = []
 */

import { describe, it } from "node:test";
import assert            from "node:assert/strict";

/**
 * tools/memory.js의 buildRecallHint 함수와 동일한 규칙을 인라인 재현.
 * recall 건수 0이면 null, 있으면 간단 hint 객체를 반환.
 */
function buildRecallHint(fragments, args) {
  if (!fragments || fragments.length === 0) return null;
  return { trigger: "recall", suggestion: "관련 파편이 있습니다." };
}

/**
 * tool_recall 핸들러의 _meta 래핑 로직 (tools/memory.js 217-237행과 동일).
 * recall 결과(result) + recall args → 최종 응답 객체.
 */
function applyRecallMeta(result, args, fragments) {
  const hint          = buildRecallHint(fragments, args);
  const searchEventId = result._searchEventId ?? null;

  if (result.caseMode) {
    const caseHint = buildRecallHint([], args);
    const caseEventId = result._searchEventId ?? null;
    return {
      success        : true,
      caseMode       : true,
      cases          : result.cases,
      caseCount      : result.caseCount,
      searchPath     : result.searchPath,
      _searchEventId : caseEventId,
      ...(caseHint ? { _memento_hint: caseHint } : {}),
      _meta: {
        searchEventId : caseEventId,
        hints         : caseHint ? [caseHint] : [],
        suggestion    : result._suggestion ?? undefined
      }
    };
  }

  return {
    success        : true,
    fragments,
    count          : fragments.length,
    totalTokens    : result.totalTokens,
    searchPath     : result.searchPath,
    _searchEventId : searchEventId,
    ...(hint       ? { _memento_hint: hint } : {}),
    _meta: {
      searchEventId,
      hints      : hint ? [hint] : [],
      suggestion : result._suggestion ?? undefined
    }
  };
}

/**
 * tool_context 핸들러의 _meta 래핑 로직 (tools/memory.js 380-390행과 동일).
 */
function applyContextMeta(result) {
  return {
    success: true,
    ...result,
    _meta: {
      searchEventId : null,
      hints         : result._memento_hint ? [result._memento_hint] : [],
      suggestion    : undefined
    }
  };
}

/** ─────────────────────────────── 테스트 ─────────────────────────────── */

describe("H1 _meta mirror — recall 일반 응답", () => {

  it("_meta.searchEventId 가 top-level _searchEventId 와 같아야 한다", () => {
    const result = {
      _searchEventId : 42,
      _suggestion    : null,
      totalTokens    : 100,
      searchPath     : "L1",
    };
    const fragments = [{ id: "f1", content: "hello" }];

    const res = applyRecallMeta(result, {}, fragments);

    assert.ok(res.success,                        "success 필드");
    assert.equal(res._searchEventId,      42,     "top-level _searchEventId mirror");
    assert.equal(res._meta.searchEventId, 42,     "_meta.searchEventId");
    assert.ok(Array.isArray(res._meta.hints),     "_meta.hints 배열");
  });

  it("hint 가 없으면 _meta.hints = [] 이고 top-level _memento_hint 없어야 함", () => {
    const result = {
      _searchEventId : 7,
      _suggestion    : null,
      totalTokens    : 0,
      searchPath     : "L3",
    };

    const res = applyRecallMeta(result, {}, []);

    assert.deepEqual(res._meta.hints, [],           "_meta.hints 빈 배열");
    assert.equal(res._meta.searchEventId, 7,        "_meta.searchEventId");
    assert.ok(!("_memento_hint" in res),            "top-level _memento_hint 없음");
  });

  it("파편이 있으면 hint 생성 → _meta.hints 비어있지 않음", () => {
    const result = {
      _searchEventId : 10,
      _suggestion    : null,
      totalTokens    : 50,
      searchPath     : "L2",
    };
    const fragments = [{ id: "f2", content: "world" }];

    const res = applyRecallMeta(result, {}, fragments);

    assert.ok(res._meta.hints.length > 0,           "_meta.hints 비어있지 않음");
    assert.ok("_memento_hint" in res,               "top-level _memento_hint 있음");
    assert.deepEqual(res._memento_hint, res._meta.hints[0], "top-level 과 _meta.hints[0] 일치");
  });

  it("_suggestion 이 _meta.suggestion 으로 반영된다", () => {
    const suggestion = { recommendedTool: "remember", recommendedArgs: {} };
    const result = {
      _searchEventId : 99,
      _suggestion    : suggestion,
      totalTokens    : 50,
      searchPath     : "L2",
    };
    const fragments = [{ id: "f3", content: "test" }];

    const res = applyRecallMeta(result, {}, fragments);

    assert.deepEqual(res._meta.suggestion, suggestion, "_meta.suggestion 일치");
  });

  it("_suggestion=null 이면 _meta.suggestion=undefined", () => {
    const result = {
      _searchEventId : 1,
      _suggestion    : null,
      totalTokens    : 10,
      searchPath     : "L1",
    };

    const res = applyRecallMeta(result, {}, []);

    assert.equal(res._meta.suggestion, undefined, "_meta.suggestion=undefined");
  });
});

describe("H1 _meta mirror — recall caseMode 응답", () => {

  it("caseMode 응답에 _meta.searchEventId, _meta.hints 가 있어야 한다", () => {
    const result = {
      caseMode       : true,
      cases          : [],
      caseCount      : 0,
      searchPath     : "CBR",
      _searchEventId : 55,
      _suggestion    : null
    };

    const res = applyRecallMeta(result, {}, []);

    assert.ok(res.caseMode,                         "caseMode 플래그");
    assert.equal(res._meta.searchEventId, 55,       "caseMode _meta.searchEventId");
    assert.ok(Array.isArray(res._meta.hints),       "caseMode _meta.hints");
    assert.equal(res._searchEventId, 55,            "top-level _searchEventId mirror");
  });
});

describe("H1 _meta mirror — context 응답", () => {

  it("context 응답에 _meta.searchEventId=null 이 있어야 한다", () => {
    const result = {
      fragments    : [],
      totalTokens  : 0,
      count        : 0,
      injectionText: ""
    };

    const res = applyContextMeta(result);

    assert.ok(res.success,                       "success");
    assert.equal(res._meta.searchEventId, null,  "context searchEventId=null");
    assert.ok(Array.isArray(res._meta.hints),    "_meta.hints 배열");
    assert.deepEqual(res._meta.hints, [],        "hint 없으면 빈 배열");
  });

  it("context _memento_hint 가 있으면 top-level mirror + _meta.hints[0] 일치", () => {
    const hint = { trigger: "recall", suggestion: "더 많은 키워드를 사용하세요" };
    const result = {
      fragments     : [],
      totalTokens   : 0,
      count         : 0,
      injectionText : "",
      _memento_hint : hint
    };

    const res = applyContextMeta(result);

    assert.deepEqual(res._memento_hint,  hint, "top-level _memento_hint mirror");
    assert.deepEqual(res._meta.hints[0], hint, "_meta.hints[0] 일치");
  });

  it("context _meta.suggestion 은 항상 undefined", () => {
    const res = applyContextMeta({ fragments: [], totalTokens: 0 });
    assert.equal(res._meta.suggestion, undefined, "context suggestion=undefined");
  });
});
