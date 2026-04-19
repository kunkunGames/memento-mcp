import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { MemoryManager } from "../../lib/memory/MemoryManager.js";

describe("MemoryManager.recall source-aware filters", () => {
  it("passes source and execution filters through to FragmentSearch", async () => {
    const searchMock = {
      search: mock.fn(async () => ({
        fragments : [{ id: "learn-1", content: "learning hit", source: "learning_extraction" }],
        totalTokens: 12,
        searchPath : "L2",
        count      : 1
      }))
    };
    const storeMock = {
      getLinkedFragments: mock.fn(async () => [])
    };

    const mm = MemoryManager.create({ search: searchMock, store: storeMock });

    const result = await mm.recall({
      agentId         : "default",
      workspace       : "maker",
      source          : "learning_extraction",
      caseId          : "case-123",
      resolutionStatus: "open",
      phase           : "debugging",
      includeLinks    : false,
      tokenBudget     : 200
    });

    assert.equal(searchMock.search.mock.callCount(), 1);

    const call = searchMock.search.mock.calls[0].arguments[0];
    assert.equal(call.source, "learning_extraction");
    assert.equal(call.caseId, "case-123");
    assert.equal(call.resolutionStatus, "open");
    assert.equal(call.phase, "debugging");
    assert.equal(call.workspace, "maker");
    assert.equal(call.agentId, "default");

    assert.equal(result.fragments.length, 1);
    assert.equal(result.fragments[0].id, "learn-1");
  });
});
