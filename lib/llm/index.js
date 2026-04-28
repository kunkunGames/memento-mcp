/**
 * LLM Dispatcher — Fallback Chain 진입점
 *
 * 작성자: 최진호
 * 작성일: 2026-04-16
 *
 * LLM_PRIMARY → LLM_FALLBACKS 순서로 chain을 구성하고,
 * 첫 번째로 성공한 provider의 응답을 반환한다.
 * 모든 provider가 실패하면 Error를 throw한다.
 *
 * lib/gemini.js의 geminiCLIJson / isGeminiCLIAvailable이 이 모듈로 위임된다.
 * 기존 5개 caller (AutoReflect, MorphemeIndex, ConsolidatorGC,
 * ContradictionDetector, MemoryEvaluator)는 코드 변경 없이 계속 동작한다.
 */

import { LLM_PRIMARY, LLM_FALLBACKS, LLM_CHAIN_TIMEOUT_MS, LLM_PROVIDER_TIMEOUT_MS } from "../config.js";
import { createProvider }                      from "./registry.js";
import { redactPrompt }                        from "./util/redact-prompt.js";
import {
  llmProviderCallsTotal,
  llmProviderLatencyMs,
  llmFallbackTriggeredTotal
}                                              from "./metrics.js";
import { logWarn }                             from "../logger.js";

// ---------------------------------------------------------------------------
// Chain 빌드
// ---------------------------------------------------------------------------

/**
 * LLM_PRIMARY + LLM_FALLBACKS 로부터 사용 가능한 provider 체인을 구성한다.
 *
 * - 중복 provider는 첫 등장 기준으로 한 번만 포함한다.
 * - isAvailable() 체크에서 실패한 provider는 체인에서 제외한다.
 *
 * @returns {Promise<import("./LlmProvider.js").LlmProvider[]>}
 */
async function buildChain() {
  /** primary 설정 객체: primary가 fallback 목록에 있으면 해당 config 사용 */
  const primaryConfig = (() => {
    const fromFallbacks = LLM_FALLBACKS.find(f => f.provider === LLM_PRIMARY);
    return fromFallbacks ?? { provider: LLM_PRIMARY };
  })();

  const entries = [primaryConfig, ...LLM_FALLBACKS];
  const seen    = new Set();
  const chain   = [];

  for (const entry of entries) {
    const name = typeof entry === "string" ? entry : entry?.provider;
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const provider = createProvider(entry);
    if (!provider) continue;

    try {
      if (await provider.isAvailable()) {
        chain.push(provider);
      }
    } catch (err) {
      logWarn(`[llm] provider ${name} isAvailable check failed: ${err.message}`);
    }
  }

  return chain;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 프롬프트를 LLM chain에 전달하여 JSON 응답을 반환한다.
 *
 * - 프롬프트는 전송 전에 redactPrompt()로 민감 데이터를 마스킹한다.
 * - 모든 provider 실패 시 Error throw.
 *
 * @param {string} prompt
 * @param {object} [options={}]
 * @param {number}  [options.timeoutMs]
 * @param {number}  [options.maxTokens]
 * @param {number}  [options.temperature]
 * @param {string}  [options.model]
 * @param {string}  [options.systemPrompt]
 * @returns {Promise<*>} 파싱된 JSON 응답
 */
export async function llmJson(prompt, options = {}) {
  const safePrompt  = redactPrompt(prompt);
  const chain       = await buildChain();
  const startedAt   = Date.now();

  if (chain.length === 0) {
    throw new Error("no LLM provider available — check LLM_PRIMARY and LLM_FALLBACKS configuration");
  }

  const primaryName = chain[0].name;
  const errors      = [];

  for (const provider of chain) {
    const remainingMs = LLM_CHAIN_TIMEOUT_MS > 0
      ? LLM_CHAIN_TIMEOUT_MS - (Date.now() - startedAt)
      : null;

    if (remainingMs !== null && remainingMs <= 0) {
      errors.push(`chain deadline exceeded after ${LLM_CHAIN_TIMEOUT_MS}ms`);
      break;
    }

    const _t = Date.now();
    llmProviderCallsTotal.inc({ provider: provider.name, outcome: "attempt" });

    try {
      const providerOptions = withProviderTimeoutCap(options, provider, remainingMs);
      const result  = await provider.callJson(safePrompt, providerOptions);
      const latency = Date.now() - _t;

      llmProviderLatencyMs.observe({ provider: provider.name }, latency);
      llmProviderCallsTotal.inc({ provider: provider.name, outcome: "success" });

      if (provider.name !== primaryName) {
        llmFallbackTriggeredTotal.inc({ primary: primaryName, fallback: provider.name });
      }

      return result;
    } catch (err) {
      llmProviderCallsTotal.inc({ provider: provider.name, outcome: "failure" });
      errors.push(`${provider.name}: ${err.message}`);
      logWarn(`[llm] ${provider.name} failed, trying next: ${err.message}`);
    }
  }

  throw new Error(`all LLM providers failed: ${errors.join("; ")}`);
}

/**
 * Apply the configured provider timeout, capped to the remaining chain deadline.
 *
 * @param {object} options
 * @param {import("./LlmProvider.js").LlmProvider} provider
 * @param {number|null} remainingMs
 * @returns {object}
 */
function withProviderTimeoutCap(options, provider, remainingMs) {
  const configuredTimeoutMs = options.timeoutMs ?? provider.config?.timeoutMs ?? LLM_PROVIDER_TIMEOUT_MS;
  const nextOptions = {
    ...options,
    timeoutMs: Number(configuredTimeoutMs)
  };

  if (remainingMs === null) return nextOptions;

  return {
    ...nextOptions,
    timeoutMs: Math.max(1, Math.min(nextOptions.timeoutMs, remainingMs))
  };
}

/**
 * LLM chain에 사용 가능한 provider가 하나 이상 있는지 확인한다.
 *
 * @returns {Promise<boolean>}
 */
export async function isLlmAvailable() {
  const chain = await buildChain();
  return chain.length > 0;
}
