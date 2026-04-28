/**
 * Unit tests: CLI provider default timeout values.
 *
 * Real CLI binaries are never invoked.
 */

import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const mockRunGeminiCLI   = mock.fn();
const mockRawIsGeminiCli = mock.fn(async () => true);
const mockRunCopilotCLI  = mock.fn();
const mockRawIsCopilotCli = mock.fn(async () => true);

mock.module("../../lib/gemini.js", {
  namedExports: {
    runGeminiCLI            : (...args) => mockRunGeminiCLI(...args),
    _rawIsGeminiCLIAvailable: (...args) => mockRawIsGeminiCli(...args)
  }
});

mock.module("../../lib/copilot.js", {
  namedExports: {
    runCopilotCLI            : (...args) => mockRunCopilotCLI(...args),
    _rawIsCopilotCLIAvailable: (...args) => mockRawIsCopilotCli(...args),
    extractJsonBlock         : (raw) => raw
  }
});

const { GeminiCliProvider } = await import("../../lib/llm/providers/GeminiCliProvider.js");
const { CopilotCliProvider } = await import("../../lib/llm/providers/CopilotCliProvider.js");

describe("CLI provider default timeoutMs", () => {
  beforeEach(() => {
    mockRunGeminiCLI.mock.resetCalls();
    mockRawIsGeminiCli.mock.resetCalls();
    mockRunCopilotCLI.mock.resetCalls();
    mockRawIsCopilotCli.mock.resetCalls();
  });

  it("gemini-cli: options/config timeout이 없으면 60000ms를 사용한다", async () => {
    mockRunGeminiCLI.mock.mockImplementationOnce(async (_stdinContent, _prompt, options) => {
      assert.equal(options.timeoutMs, 60_000);
      return "{\"ok\":true}";
    });

    const provider = new GeminiCliProvider();
    const result = await provider.callJson("user payload");

    assert.deepEqual(result, { ok: true });
  });

  it("gemini-cli: provider config timeoutMs를 사용한다", async () => {
    mockRunGeminiCLI.mock.mockImplementationOnce(async (_stdinContent, _prompt, options) => {
      assert.equal(options.timeoutMs, 2222);
      return "{\"ok\":true}";
    });

    const provider = new GeminiCliProvider({ timeoutMs: 2222 });
    const result = await provider.callJson("user payload");

    assert.deepEqual(result, { ok: true });
  });

  it("copilot-cli: options/config timeout이 없으면 60000ms를 사용한다", async () => {
    mockRunCopilotCLI.mock.mockImplementationOnce(async (_prompt, options) => {
      assert.equal(options.timeoutMs, 60_000);
      return "{\"ok\":true}";
    });

    const provider = new CopilotCliProvider();
    const result = await provider.callJson("user payload");

    assert.deepEqual(result, { ok: true });
  });

  it("copilot-cli: provider config timeoutMs를 사용한다", async () => {
    mockRunCopilotCLI.mock.mockImplementationOnce(async (_prompt, options) => {
      assert.equal(options.timeoutMs, 3333);
      return "{\"ok\":true}";
    });

    const provider = new CopilotCliProvider({ timeoutMs: 3333 });
    const result = await provider.callJson("user payload");

    assert.deepEqual(result, { ok: true });
  });
});
