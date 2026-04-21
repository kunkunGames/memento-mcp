/**
 * BatchRememberProcessor onProgress 콜백 단위 테스트 (M4)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 *
 * onProgress 콜백이 Phase A/B/C 각각 1회 이상 호출되는지,
 * 미제공 시 기존 동작이 유지되는지,
 * 이벤트 필드(phase/processed/total/skipped/errors)가 포함되는지 검증한다.
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { BatchRememberProcessor } from "../../lib/memory/BatchRememberProcessor.js";
import { disconnectRedis }        from "../../lib/redis.js";

after(async () => { await disconnectRedis().catch(() => {}); });

/* ── 헬퍼: factory mock ── */

function makeMockFactory() {
  let seq = 0;
  return {
    create(item) {
      seq++;
      const id = `frag-${seq}`;
      return {
        id,
        content          : item.content,
        topic            : item.topic,
        type             : item.type,
        keywords         : item.keywords || [],
        importance       : item.importance ?? 0.5,
        content_hash     : `hash-${seq}`,
        source           : null,
        linked_to        : [],
        ttl_tier         : "warm",
        estimated_tokens : 10,
        valid_from       : new Date().toISOString(),
        is_anchor        : false,
        context_summary  : null,
        session_id       : null,
        workspace        : null,
        case_id          : null,
        goal             : null,
        outcome          : null,
        phase            : null,
        resolution_status: null,
        assertion_status : "observed"
      };
    }
  };
}

function makeMockPool(overrides = {}) {
  return {
    connect: async () => ({
      query  : async (sql) => {
        if (typeof overrides.query === "function") return overrides.query(sql);
        /** INSERT ... RETURNING id */
        if (sql.includes("RETURNING id")) return { rows: [{ id: `db-${Date.now()}` }] };
        return { rows: [], rowCount: 0 };
      },
      release: () => {}
    })
  };
}

function makeProcessor() {
  const store = { index: async () => {} };
  const index = { index: async () => {} };
  const proc  = new BatchRememberProcessor({ store, index, factory: makeMockFactory() });
  proc.setPool(makeMockPool());
  return proc;
}

function validFragments(count = 3) {
  return Array.from({ length: count }, (_, i) => ({
    content: `테스트 파편 ${i + 1}: 구체적인 사실 내용`,
    topic  : "test",
    type   : "fact"
  }));
}

/* ── 테스트 ── */

describe("BatchRememberProcessor onProgress (M4)", () => {
  it("onProgress 콜백이 Phase A, B, C 각각 한 번 이상 호출된다", async () => {
    const proc   = makeProcessor();
    const events = [];

    await proc.process(
      { fragments: validFragments(3), agentId: "agent-1" },
      (ev) => events.push(ev)
    );

    const phases = events.map(e => e.phase);
    assert.ok(phases.includes("A"), "Phase A 이벤트 누락");
    assert.ok(phases.includes("B"), "Phase B 이벤트 누락");
    assert.ok(phases.includes("C"), "Phase C 이벤트 누락");
  });

  it("각 progress 이벤트가 required 필드(phase, processed, total, skipped, errors)를 포함한다", async () => {
    const proc   = makeProcessor();
    const events = [];

    await proc.process(
      { fragments: validFragments(2), agentId: "agent-1" },
      (ev) => events.push(ev)
    );

    assert.ok(events.length > 0, "이벤트가 1건 이상 발생해야 함");

    for (const ev of events) {
      assert.ok("phase"     in ev, `phase 필드 누락: ${JSON.stringify(ev)}`);
      assert.ok("processed" in ev, `processed 필드 누락: ${JSON.stringify(ev)}`);
      assert.ok("total"     in ev, `total 필드 누락: ${JSON.stringify(ev)}`);
      assert.ok("skipped"   in ev, `skipped 필드 누락: ${JSON.stringify(ev)}`);
      assert.ok("errors"    in ev, `errors 필드 누락: ${JSON.stringify(ev)}`);
      assert.strictEqual(typeof ev.processed, "number");
      assert.strictEqual(typeof ev.total,     "number");
      assert.strictEqual(ev.total, 2);
    }
  });

  it("onProgress 미제공 시 기존 동작 유지 (에러 없이 완료)", async () => {
    const proc = makeProcessor();

    const result = await proc.process(
      { fragments: validFragments(2), agentId: "agent-1" }
      /** onProgress 인자 생략 */
    );

    assert.ok(result, "결과 객체가 반환되어야 함");
    assert.ok("inserted" in result, "inserted 필드 누락");
    assert.ok("skipped"  in result, "skipped 필드 누락");
    assert.ok(Array.isArray(result.results), "results 배열 누락");
  });

  it("onProgress가 null 일 때도 에러 없이 완료된다", async () => {
    const proc = makeProcessor();

    const result = await proc.process(
      { fragments: validFragments(1), agentId: "agent-1" },
      null
    );

    assert.ok(result.inserted >= 0);
  });
});
