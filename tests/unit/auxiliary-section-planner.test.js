import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import {
  buildHeuristicAuxiliaryPlan,
  planAuxiliarySections
} from "../../lib/memory/AuxiliarySectionPlanner.js";

describe("AuxiliarySectionPlanner", () => {
  it("heuristic planner가 debugging 질의에서 error_playbook을 고른다", () => {
    const result = buildHeuristicAuxiliaryPlan({
      contextText: "에러 원인과 디버깅 힌트가 필요하다",
      phase      : "debugging",
      maxSections: 3
    });

    assert.ok(result.sections.includes("error_playbook"));
  });

  it("heuristic planner가 절차/배포 질의에서 procedure_memory를 고른다", () => {
    const result = buildHeuristicAuxiliaryPlan({
      contextText: "배포 절차와 복구 단계가 필요하다",
      maxSections: 3
    });

    assert.ok(result.sections.includes("procedure_memory"));
  });

  it("heuristic planner는 maxSections=2일 때 learning보다 error/procedure를 우선한다", () => {
    const result = buildHeuristicAuxiliaryPlan({
      contextText: "에러 복구 절차를 알려줘",
      phase      : "debugging",
      maxSections: 2
    });

    assert.deepEqual(result.sections, ["error_playbook", "procedure_memory"]);
  });

  it("LLM planner 결과를 sanitize하여 허용된 섹션만 유지한다", async () => {
    const llmJsonFn = mock.fn(async () => ({
      sections : ["decision_memory", "invalid_section", "case_memory"],
      rationale: "planning + history"
    }));
    const isLlmAvailableFn = mock.fn(async () => true);

    const result = await planAuxiliarySections({
      contextText      : "왜 이렇게 설계했고 이전 비슷한 케이스가 있었는지 보고 싶다",
      maxSections      : 3,
      llmJsonFn,
      isLlmAvailableFn
    });

    assert.deepEqual(result.sections, ["decision_memory", "case_memory"]);
    assert.equal(result.source, "llm");
  });

  it("LLM 실패 시 heuristic fallback을 사용한다", async () => {
    const llmJsonFn = mock.fn(async () => {
      throw new Error("llm down");
    });
    const isLlmAvailableFn = mock.fn(async () => true);

    const result = await planAuxiliarySections({
      contextText      : "이전에 비슷했던 사례랑 미해결 질문이 있나",
      resolutionStatus : "open",
      maxSections      : 5,
      llmJsonFn,
      isLlmAvailableFn
    });

    assert.equal(result.source, "heuristic");
    assert.ok(result.sections.includes("error_playbook"));
    assert.ok(result.sections.includes("case_memory"));
    assert.ok(result.sections.includes("open_questions_memory"));
  });
});
