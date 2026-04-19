import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { FragmentReader } from "../../lib/memory/FragmentReader.js";
import { FragmentSearch } from "../../lib/memory/FragmentSearch.js";

describe("FragmentSearch source filter", () => {
  it("source-only query는 L2에서 searchBySource fallback을 사용한다", async () => {
    const search = new FragmentSearch();
    search.store = {
      searchByKeywords: mock.fn(async () => []),
      searchByTopic   : mock.fn(async () => []),
      searchBySource  : mock.fn(async () => [
        { id: "learn-1", content: "learning", source: "learning_extraction", importance: 0.8 }
      ]),
      getByIds        : mock.fn(async () => [])
    };

    const results = await search._searchL2(
      { source: "learning_extraction", minImportance: 0.3, workspace: "maker" },
      [],
      "default",
      null,
      null
    );

    assert.equal(search.store.searchBySource.mock.callCount(), 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "learn-1");
  });

  it("source fallback은 group key 배열과 includeSuperseded를 그대로 전달한다", async () => {
    const search = new FragmentSearch();
    search.store = {
      searchByKeywords: mock.fn(async () => []),
      searchByTopic   : mock.fn(async () => []),
      searchBySource  : mock.fn(async () => [
        { id: "learn-1", content: "learning", source: "learning_extraction", importance: 0.8 }
      ]),
      getByIds        : mock.fn(async () => [])
    };

    await search._searchL2(
      { source: "learning_extraction", includeSuperseded: true, workspace: "maker" },
      [],
      "default",
      ["key-a", "key-b"],
      null
    );

    assert.equal(search.store.searchBySource.mock.callCount(), 1);
    assert.deepEqual(
      search.store.searchBySource.mock.calls[0].arguments,
      [
        "learning_extraction",
        "default",
        ["key-a", "key-b"],
        30,
        "maker",
        true,
        { minImportance: 0.1 }
      ]
    );
  });

  it("source fallback은 narrative 필터를 searchBySource SQL 경로로 전달한다", async () => {
    const search = new FragmentSearch();
    search.store = {
      searchByKeywords: mock.fn(async () => []),
      searchByTopic   : mock.fn(async () => []),
      searchBySource  : mock.fn(async () => [
        { id: "learn-1", content: "learning", source: "learning_extraction", importance: 0.8 }
      ]),
      getByIds        : mock.fn(async () => [])
    };

    const timeRange = { from: "2026-04-01T00:00:00.000Z", to: "2026-04-20T00:00:00.000Z" };

    await search._searchL2(
      {
        source          : "learning_extraction",
        workspace       : "maker",
        caseId          : "case-123",
        resolutionStatus: "open",
        phase           : "debugging",
        type            : "fact",
        minImportance   : 0.4
      },
      [],
      "default",
      ["key-a", "key-b"],
      timeRange
    );

    assert.deepEqual(
      search.store.searchBySource.mock.calls[0].arguments,
      [
        "learning_extraction",
        "default",
        ["key-a", "key-b"],
        30,
        "maker",
        false,
        {
          type            : "fact",
          minImportance   : 0.4,
          timeRange,
          caseId          : "case-123",
          resolutionStatus: "open",
          phase           : "debugging"
        }
      ]
    );
  });

  it("_executeSearch는 HotCache/L1 경로에서도 source 후처리 필터를 적용한다", async () => {
    const search = new FragmentSearch();
    search._searchL1 = mock.fn(async () => ({ ids: ["keep", "drop"], isFallback: false }));
    search._tryHotCache = mock.fn(async () => [
      { id: "keep", content: "matched learning", source: "learning_extraction" },
      { id: "drop", content: "other source", source: "session:abcd" }
    ]);
    search._searchL2 = mock.fn(async () => []);
    search._searchL3 = mock.fn(async () => []);
    search._searchTemporal = mock.fn(async () => []);

    const result = await search._executeSearch(
      {
        source    : "learning_extraction",
        agentId   : "default",
        keyId     : null,
        workspace : null,
        timeRange : null,
        text      : null,
        caseId    : undefined,
        phase     : undefined,
        resolutionStatus: undefined
      },
      Promise.resolve({ record: () => {} })
    );

    assert.deepEqual(result.combined.map(f => f.id), ["keep"]);
  });
});

describe("searchBySource SQL filters", () => {
  it("searchBySource는 source fallback용 narrative 필터를 SQL로 적용한다", () => {
    const src = FragmentReader.prototype.searchBySource.toString();
    assert.ok(src.includes("case_id = $"), "searchBySource should filter case_id in SQL");
    assert.ok(src.includes("resolution_status = $"), "searchBySource should filter resolution_status in SQL");
    assert.ok(src.includes("phase = $"), "searchBySource should filter phase in SQL");
  });
});
