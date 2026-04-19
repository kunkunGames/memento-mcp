/**
 * AuxiliarySectionPlanner — query-aware auxiliary memory section selection
 *
 * hardening=true 컨텍스트 주입 경로에서
 * user 질의 + 추가 signal(case/phase/resolution_status)을 바탕으로
 * 어떤 보조 메모리 섹션을 붙일지 결정한다.
 *
 * 기본 경로:
 *   1) LLM planner (llmJson)
 *   2) 실패/비가용 시 heuristic fallback
 */

import { MEMORY_CONFIG } from "../../config/memory.js";
import { llmJson, isLlmAvailable } from "../llm/index.js";
import { logWarn } from "../logger.js";

export const AUXILIARY_SECTION_CATALOG = {
  learning_memory: {
    title      : "LEARNING MEMORY",
    description: "Prior extracted learnings relevant to the current user question or conversation context."
  },
  error_playbook: {
    title      : "ERROR PLAYBOOK",
    description: "Past error fragments and fix clues relevant to debugging, failures, or open issues."
  },
  decision_memory: {
    title      : "DECISION MEMORY",
    description: "Past architectural or product decisions relevant to planning, tradeoffs, or why-questions."
  },
  open_questions_memory: {
    title      : "OPEN QUESTIONS MEMORY",
    description: "Unresolved questions or pending follow-ups relevant to the current task."
  },
  case_memory: {
    title      : "CASE MEMORY",
    description: "Similar or same-case history that can guide the current situation."
  }
};

const DEBUG_OR_ERROR_RE =
  /(error|bug|fail|failure|debug|debugging|trace|exception|incident|issue|에러|버그|실패|디버그|예외|문제)/i;
const DECISION_RE =
  /(decision|tradeoff|design|architecture|approach|why|choose|choice|선택|결정|설계|구조|방식|이유)/i;
const HISTORY_RE =
  /(before|previous|prior|again|similar|history|past|이전에|전에|과거|비슷|다시)/i;
const OPEN_QUESTION_RE =
  /(unknown|unclear|question|todo|next step|blocked|uncertain|pending|미해결|질문|다음|막힘|불명확|확실하지)/i;

function unique(items) {
  return [...new Set(items)];
}

function sanitizeSections(sections, maxSections) {
  if (!Array.isArray(sections)) return [];
  return unique(
    sections.filter((name) => Object.hasOwn(AUXILIARY_SECTION_CATALOG, name))
  ).slice(0, maxSections);
}

export function buildHeuristicAuxiliaryPlan({
  contextText = "",
  caseId = null,
  resolutionStatus = null,
  phase = null,
  maxSections = MEMORY_CONFIG.contextInjection?.maxAuxiliarySections || 2
} = {}) {
  const query = typeof contextText === "string" ? contextText.trim() : "";
  const picks = [];

  if (query) {
    picks.push("learning_memory");
  }
  if (phase === "debugging" || resolutionStatus === "open" || DEBUG_OR_ERROR_RE.test(query)) {
    picks.push("error_playbook");
  }
  if (phase === "planning" || DECISION_RE.test(query)) {
    picks.push("decision_memory");
  }
  if (caseId || HISTORY_RE.test(query)) {
    picks.push("case_memory");
  }
  if (resolutionStatus === "open" || OPEN_QUESTION_RE.test(query)) {
    picks.push("open_questions_memory");
  }

  return {
    sections : sanitizeSections(picks, maxSections),
    source   : "heuristic",
    rationale: "signal-based fallback"
  };
}

export async function planAuxiliarySections({
  contextText = "",
  caseId = null,
  resolutionStatus = null,
  phase = null,
  llmPlannerEnabled = MEMORY_CONFIG.contextInjection?.llmPlannerEnabled !== false,
  maxSections = MEMORY_CONFIG.contextInjection?.maxAuxiliarySections || 2,
  llmJsonFn = llmJson,
  isLlmAvailableFn = isLlmAvailable
} = {}) {
  const query = typeof contextText === "string" ? contextText.trim() : "";
  const hasSignals = Boolean(query || caseId || resolutionStatus || phase);
  if (!hasSignals) {
    return { sections: [], source: "none", rationale: "no planning signals" };
  }

  const heuristicPlan = buildHeuristicAuxiliaryPlan({
    contextText      : query,
    caseId,
    resolutionStatus,
    phase,
    maxSections
  });

  if (!llmPlannerEnabled) {
    return heuristicPlan;
  }

  try {
    if (!(await isLlmAvailableFn())) {
      return heuristicPlan;
    }

    const candidates = Object.entries(AUXILIARY_SECTION_CATALOG)
      .map(([name, meta]) => `- ${name}: ${meta.description}`)
      .join("\n");

    const systemPrompt =
      "You are a JSON-only planner for auxiliary memory injection. " +
      "Return valid JSON only. Do not include markdown or explanations outside JSON.";

    const userPrompt = [
      `Select up to ${maxSections} auxiliary memory sections for the current context.`,
      "",
      "Current signals:",
      `- user_query: ${query || "(empty)"}`,
      `- case_id: ${caseId || "(none)"}`,
      `- resolution_status: ${resolutionStatus || "(none)"}`,
      `- phase: ${phase || "(none)"}`,
      "",
      "Candidate sections:",
      candidates,
      "",
      `Heuristic suggestion: ${heuristicPlan.sections.join(", ") || "(none)"}`,
      "",
      "Return JSON in this exact shape:",
      '{"sections":["candidate_name"],"rationale":"short reason"}',
      "",
      "Selection rules:",
      "- Select only sections that materially help the current context.",
      "- Prefer 0-2 sections; do not select a section just because it exists.",
      "- If the query is vague or no section clearly helps, return an empty array."
    ].join("\n");

    const result = await llmJsonFn(userPrompt, {
      timeoutMs   : 15_000,
      temperature : 0,
      systemPrompt
    });

    const sections = sanitizeSections(result?.sections, maxSections);
    return {
      sections,
      source   : "llm",
      rationale: typeof result?.rationale === "string" ? result.rationale : null
    };
  } catch (err) {
    logWarn(`[AuxiliarySectionPlanner] LLM planner failed, fallback to heuristic: ${err.message}`);
    return heuristicPlan;
  }
}
