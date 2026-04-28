/**
 * OpenCode CLI Client (memento-mcp)
 *
 * public API:
 *   _rawIsOpenCodeCLIAvailable() -- checks for the local `opencode` binary
 *   isOpenCodeCLIAvailable()     -- delegates to the full LLM chain
 *   runOpenCodeCLI()             -- low-level CLI call for OpenCodeCliProvider
 */

import { spawn } from "child_process";

let _openCodeCLICached = null;

/**
 * Check whether the OpenCode CLI binary is installed.
 *
 * @returns {Promise<boolean>}
 */
export async function _rawIsOpenCodeCLIAvailable() {
  if (_openCodeCLICached !== null) return _openCodeCLICached;
  try {
    const { execSync } = await import("child_process");
    execSync("which opencode", { stdio: "ignore", timeout: 5000 });
    _openCodeCLICached = true;
  } catch {
    _openCodeCLICached = false;
  }
  return _openCodeCLICached;
}

/**
 * Check whether any LLM provider in the configured chain is available.
 *
 * @returns {Promise<boolean>}
 */
export async function isOpenCodeCLIAvailable() {
  const { isLlmAvailable } = await import("./llm/index.js");
  return isLlmAvailable();
}

/**
 * Run OpenCode in non-interactive mode and return stdout.
 *
 * @param {string} prompt
 * @param {object} [options={}]
 * @param {number} [options.timeoutMs=40000]
 * @param {string} [options.model]   - provider/model value passed to `--model`
 * @param {string} [options.agent]   - optional OpenCode agent
 * @param {string} [options.variant] - optional model variant
 * @param {string} [options.cwd]     - working directory for OpenCode context
 * @returns {Promise<string>}
 */
export async function runOpenCodeCLI(prompt, options = {}) {
  const timeoutMs = options.timeoutMs ?? 40_000;
  const cwd       = options.cwd ?? process.cwd();

  return new Promise((resolve, reject) => {
    const args = [
      "run",
      "--format", "default",
      "--dir", cwd,
      "--pure"
    ];

    if (options.model) args.push("--model", options.model);
    if (options.agent) args.push("--agent", options.agent);
    if (options.variant) args.push("--variant", options.variant);
    args.push(prompt);

    const proc = spawn("opencode", args, {
      env  : { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout  = "";
    let stderr  = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill("SIGTERM");
        reject(new Error(`OpenCode CLI timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      if (code !== 0) {
        const detail = (stderr || stdout).trim().slice(0, 1000);
        reject(new Error(`OpenCode CLI exited with code ${code}: ${detail}`));
        return;
      }

      resolve(stdout.trim());
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`OpenCode CLI spawn error: ${err.message}`));
      }
    });
  });
}
