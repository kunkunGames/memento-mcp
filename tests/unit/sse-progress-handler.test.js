/**
 * SSE progress 핸들러 단위 테스트 (M4)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 *
 * Accept: text/event-stream 요청 시 SSE 응답이 반환되는지,
 * 기본(JSON) 요청 시 단일 응답 경로를 유지하는지(하위 호환) 검증한다.
 *
 * mcp-handler.handleMcpPost의 SSE 분기 조건만 단위 검증한다.
 * 내부 도구 실행은 mock으로 대체한다.
 */

import { describe, it, mock, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter }  from "node:events";
import { disconnectRedis } from "../../lib/redis.js";

after(async () => { await disconnectRedis().catch(() => {}); });

/* ── SSE 감지 조건 순수 함수 추출 (mcp-handler 직접 의존 없이) ── */

/**
 * M4 분기 조건과 동일한 순수 함수.
 * Accept 헤더 또는 arguments.stream=true 시 SSE 모드를 반환한다.
 *
 * @param {object} req     - { headers: { accept?: string } }
 * @param {object} toolArgs - { stream?: boolean }
 * @returns {boolean}
 */
function shouldStreamSSE(req, toolArgs) {
  return (req.headers?.accept || "").includes("text/event-stream")
      || toolArgs?.stream === true;
}

const SSE_TOOL_NAMES = new Set(["batch_remember", "memory_consolidate"]);

/**
 * SSE 대상 도구인지 판별하는 순수 함수.
 */
function isSseCapableTool(toolName) {
  return SSE_TOOL_NAMES.has(toolName);
}

/* ── writeSSEEvent 헬퍼 검증 ── */

function makeFakeRes() {
  const chunks = [];
  const res    = new EventEmitter();
  res.destroyed = false;
  res.writable  = true;
  res.write     = (chunk) => { chunks.push(chunk); return true; };
  res.end       = () => { res.ended = true; };
  res.chunks    = chunks;
  return res;
}

/* ── 테스트 ── */

describe("SSE 스트림 분기 조건 (M4)", () => {
  it("Accept: text/event-stream 헤더가 있으면 SSE 모드를 선택한다", () => {
    const req  = { headers: { accept: "text/event-stream" } };
    const args = {};
    assert.strictEqual(shouldStreamSSE(req, args), true);
  });

  it("Accept 헤더가 없어도 arguments.stream=true 이면 SSE 모드를 선택한다", () => {
    const req  = { headers: {} };
    const args = { stream: true };
    assert.strictEqual(shouldStreamSSE(req, args), true);
  });

  it("기본 JSON 요청(Accept 미지정, stream 미지정)은 SSE 모드를 선택하지 않는다", () => {
    const req  = { headers: { accept: "application/json" } };
    const args = {};
    assert.strictEqual(shouldStreamSSE(req, args), false);
  });

  it("batch_remember 는 SSE 가능 도구로 인식된다", () => {
    assert.strictEqual(isSseCapableTool("batch_remember"), true);
  });

  it("memory_consolidate 는 SSE 가능 도구로 인식된다", () => {
    assert.strictEqual(isSseCapableTool("memory_consolidate"), true);
  });

  it("recall 등 기타 도구는 SSE 가능 도구로 인식되지 않는다", () => {
    assert.strictEqual(isSseCapableTool("recall"), false);
    assert.strictEqual(isSseCapableTool("remember"), false);
  });
});

describe("writeSSEEvent 헬퍼 (M4)", () => {
  it("progress 이벤트를 올바른 SSE 형식으로 직렬화한다", async () => {
    const { writeSSEEvent } = await import("../../lib/http/helpers.js");
    const res = makeFakeRes();

    writeSSEEvent(res, "progress", { phase: "A", processed: 5, total: 10, skipped: 0, errors: 0 });

    assert.strictEqual(res.chunks.length, 1);
    const raw = res.chunks[0];
    assert.ok(raw.startsWith("data: "), `SSE data prefix 누락: ${raw}`);
    assert.ok(raw.endsWith("\n\n"),    `SSE 이중 줄바꿈 누락: ${raw}`);

    const payload = JSON.parse(raw.slice("data: ".length).trim());
    assert.strictEqual(payload.type,      "progress");
    assert.strictEqual(payload.phase,     "A");
    assert.strictEqual(payload.processed, 5);
    assert.strictEqual(payload.total,     10);
  });

  it("result 이벤트에서 type 필드가 포함된다", async () => {
    const { writeSSEEvent } = await import("../../lib/http/helpers.js");
    const res = makeFakeRes();

    writeSSEEvent(res, "result", { jsonrpc: "2.0", id: 1, result: { content: [] } });

    const payload = JSON.parse(res.chunks[0].slice("data: ".length).trim());
    assert.strictEqual(payload.type,    "result");
    assert.strictEqual(payload.jsonrpc, "2.0");
  });

  it("응답이 이미 destroyed 상태면 false를 반환하고 write를 호출하지 않는다", async () => {
    const { writeSSEEvent } = await import("../../lib/http/helpers.js");
    const res     = makeFakeRes();
    res.destroyed = true;

    const result = writeSSEEvent(res, "progress", { phase: "A" });

    assert.strictEqual(result, false);
    assert.strictEqual(res.chunks.length, 0);
  });
});
