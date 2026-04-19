import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

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
