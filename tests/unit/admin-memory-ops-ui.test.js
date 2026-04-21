/**
 * admin.js -- Memory Operations 렌더러 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-26
 * 수정일: 2026-04-19 (ESM 모듈 직접 import 방식으로 전환)
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDom, flatQuery } from "./admin-test-helper.js";

/* DOM mock을 모듈 import 전에 주입 */
setupDom();

const {
  renderMemoryFilters,
  renderFragmentList,
  renderRetrievalAnalytics,
  renderAnomalyCards,
  renderRecentEventsChart,
  renderFragmentInspector,
  renderPagination
} = await import("../../assets/admin/modules/memory.js");

const { state } = await import("../../assets/admin/modules/state.js");

/* ================================================================
   Memory Filters
   ================================================================ */

describe("renderMemoryFilters", () => {
  test("glass-panel + border-l-2 border-primary/40", () => {
    const bar = renderMemoryFilters();
    assert.ok(bar.className.includes("glass-panel"));
    assert.ok(bar.className.includes("border-l-2"));
    assert.ok(bar.className.includes("border-primary/40"));
  });

  test("filter-topic, filter-type, filter-key-id 존재", () => {
    const bar = renderMemoryFilters();
    const all = [];
    function walk(n) { all.push(n); (n.children ?? []).forEach(walk); }
    walk(bar);
    assert.ok(all.some(n => n.dataset?._id === "filter-topic"), "topic input");
    assert.ok(all.some(n => n.dataset?._id === "filter-type"), "type select");
    assert.ok(all.some(n => n.dataset?._id === "filter-key-id"), "key input");
  });

  test("SEARCH 버튼 존재", () => {
    const bar = renderMemoryFilters();
    const all = [];
    function walk(n) { all.push(n); (n.children ?? []).forEach(walk); }
    walk(bar);
    assert.ok(all.some(n => n.dataset?._id === "filter-search"), "filter-search button");
  });
});

/* ================================================================
   Fragment List (Search Explorer)
   ================================================================ */

describe("renderFragmentList", () => {
  test("fragments 비어있으면 빈 상태 텍스트", () => {
    const el = renderFragmentList([]);
    assert.ok(el.textContent.includes("결과 없음"));
  });

  test("glass-panel + shadow-2xl + overflow-hidden", () => {
    const frags = [{ id: "f1", topic: "test", type: "fact", content: "hello", importance: 0.8, created_at: "2024-01-01" }];
    state.selectedFragment = null;
    const panel = renderFragmentList(frags);
    assert.ok(panel.className.includes("glass-panel"));
    assert.ok(panel.className.includes("shadow-2xl"));
    assert.ok(panel.className.includes("overflow-hidden"));
  });

  test("query box with bg-surface-container-highest", () => {
    const frags = [{ id: "f1", topic: "t", type: "fact", content: "c" }];
    state.selectedFragment = null;
    const panel = renderFragmentList(frags);
    const queryBox = panel.querySelector(".bg-surface-container-highest");
    assert.ok(queryBox, "query box 존재");
  });

  test("fragment item에 ID badge + UTILITY_SCORE + ACCESS", () => {
    const frags = [{ id: "f1", topic: "arch", type: "decision", content: "content", importance: 0.9, access_count: 5, created_at: "2024-06-01" }];
    state.selectedFragment = null;
    const panel = renderFragmentList(frags);
    const item = panel.querySelector("[data-frag-id]");
    assert.ok(item, "fragment item 존재");

    const all = [];
    function walk(n) { all.push(n); (n.children ?? []).forEach(walk); }
    walk(item);
    assert.ok(all.some(n => (n.textContent ?? "").includes("#MEM_")), "ID badge");
    assert.ok(all.some(n => (n.textContent ?? "").includes("UTILITY_SCORE")), "UTILITY_SCORE label");
    assert.ok(all.some(n => (n.textContent ?? "").includes("ACCESS")), "ACCESS label");
  });
});

/* ================================================================
   Retrieval Analytics
   ================================================================ */

describe("renderRetrievalAnalytics", () => {
  test("glass-panel + border-primary/20", () => {
    const panel = renderRetrievalAnalytics({});
    assert.ok(panel.className.includes("glass-panel"));
    assert.ok(panel.className.includes("border-primary/20"));
  });

  test("Retrieval Analytics 타이틀", () => {
    const panel = renderRetrievalAnalytics({});
    const all = [];
    function walk(n) { all.push(n); (n.children ?? []).forEach(walk); }
    walk(panel);
    assert.ok(all.some(n => (n.textContent ?? "").includes("Retrieval Analytics")));
  });

  test("HIT RATE + RERANK USAGE", () => {
    const panel = renderRetrievalAnalytics({});
    const all = [];
    function walk(n) { all.push(n); (n.children ?? []).forEach(walk); }
    walk(panel);
    assert.ok(all.some(n => (n.textContent ?? "").includes("HIT RATE")));
    assert.ok(all.some(n => (n.textContent ?? "").includes("RERANK USAGE")));
  });
});

/* ================================================================
   Anomaly Cards
   ================================================================ */

describe("renderAnomalyCards", () => {
  test("anomalies=null이면 empty fragment", () => {
    const el = renderAnomalyCards(null);
    assert.equal(el.children.length, 0);
  });

  test("glass-panel + border-error/20", () => {
    const panel = renderAnomalyCards({ contradictions: 2 });
    assert.ok(panel.className.includes("glass-panel"));
    assert.ok(panel.className.includes("border-error/20"));
  });

  test("4 anomaly items", () => {
    const panel = renderAnomalyCards({ contradictions: 0, superseded: 0, qualityUnverified: 0, embeddingBacklog: 0 });
    const items = panel.querySelectorAll("[data-anomaly]");
    assert.equal(items.length, 4);
  });

  test("critical item with bg-error-container/10", () => {
    const panel = renderAnomalyCards({ contradictions: 3 });
    const critical = panel.querySelector(".bg-error-container\\/10");
    assert.ok(critical);
  });
});

/* ================================================================
   Recent Events Chart
   ================================================================ */

describe("renderRecentEventsChart", () => {
  test("glass-panel wrapper", () => {
    const panel = renderRecentEventsChart();
    assert.ok(panel.className.includes("glass-panel"));
  });

  test("RECALL_EVENTS + QUERY_LOAD legend", () => {
    const panel = renderRecentEventsChart();
    const all = [];
    function walk(n) { all.push(n); (n.children ?? []).forEach(walk); }
    walk(panel);
    assert.ok(all.some(n => (n.textContent ?? "").includes("RECALL_EVENTS")));
    assert.ok(all.some(n => (n.textContent ?? "").includes("QUERY_LOAD")));
  });

  test("bg-surface-container-lowest chart area", () => {
    const panel = renderRecentEventsChart();
    assert.ok(panel.querySelector(".bg-surface-container-lowest"));
  });
});

/* ================================================================
   Fragment Inspector
   ================================================================ */

describe("renderFragmentInspector", () => {
  test("fragment=null이면 empty fragment", () => {
    const el = renderFragmentInspector(null);
    assert.equal(el.children.length, 0);
  });

  test("glass-panel + border-primary/20", () => {
    const frag = { id: "f1", content: "test", type: "fact", importance: 0.8, created_at: "2024-01-01" };
    const panel = renderFragmentInspector(frag);
    assert.ok(panel.className.includes("glass-panel"));
    assert.ok(panel.className.includes("border-primary/20"));
  });
});

/* ================================================================
   Pagination
   ================================================================ */

describe("renderPagination", () => {
  test("memoryPages <= 1이면 빈 fragment", () => {
    state.memoryPages = 1;
    const el = renderPagination();
    assert.equal(el.children.length, 0);
  });

  test("memoryPages=3이면 5개 버튼 (prev + 3 pages + next)", () => {
    state.memoryPages = 3;
    state.memoryPage  = 1;
    const wrap = renderPagination();
    const buttons = flatQuery(wrap, "button");
    assert.equal(buttons.length, 5);
  });
});
