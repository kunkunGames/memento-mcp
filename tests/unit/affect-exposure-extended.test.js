import { describe, it } from "node:test";
import assert from "node:assert";
import {
  recallDefinition,
  batchRememberDefinition,
  amendDefinition,
  reconstructHistoryDefinition,
  searchTracesDefinition
} from "../../lib/tools/memory-schemas.js";

describe("Tool Registry Schema - affect parameter exposure", () => {
  it("recall schema should have affect parameter", () => {
    assert.ok(recallDefinition.inputSchema.properties.affect, "recall should have affect");
    assert.strictEqual(recallDefinition.inputSchema.properties.affect.description.includes("정서 태그 필터"), true);
  });

  it("batch_remember schema should have affect parameter in fragments", () => {
    const fragmentSchema = batchRememberDefinition.inputSchema.properties.fragments.items;
    assert.ok(fragmentSchema.properties.affect, "batch_remember fragments should have affect");
    assert.deepStrictEqual(fragmentSchema.properties.affect.enum, ["neutral", "frustration", "confidence", "surprise", "doubt", "satisfaction"]);
  });

  it("amend schema should have affect parameter", () => {
    assert.ok(amendDefinition.inputSchema.properties.affect, "amend should have affect");
    assert.deepStrictEqual(amendDefinition.inputSchema.properties.affect.enum, ["neutral", "frustration", "confidence", "surprise", "doubt", "satisfaction"]);
  });

  it("reconstruct_history schema should have affect parameter", () => {
    assert.ok(reconstructHistoryDefinition.inputSchema.properties.affect, "reconstruct_history should have affect");
  });

  it("search_traces schema should have affect parameter", () => {
    assert.ok(searchTracesDefinition.inputSchema.properties.affect, "search_traces should have affect");
  });
});
