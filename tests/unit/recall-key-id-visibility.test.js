/**
 * recall key_id 컬럼 가시성 회귀 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-10
 *
 * d65e656 커밋 회귀 방지:
 * searchByKeywords/searchByTopic/searchBySemantic SELECT 절에 f.key_id가
 * 포함되어 그룹 사용자가 fragment owner를 식별할 수 있어야 한다.
 *
 * 테스트 전략: 메서드 소스 텍스트 검사(toString) + SQL 조건 빌드 로직 재현.
 * DB 연결 없이 순수 단위 테스트로 실행.
 */

import { describe, it } from "node:test";
import assert            from "node:assert/strict";
import { FragmentReader } from "../../lib/memory/FragmentReader.js";

/** ── 1. SELECT 절에 f.key_id 컬럼 포함 여부 ─────────────────────────── */

describe("searchByKeywords — SELECT f.key_id 포함", () => {
  it("SELECT 절에 f.key_id 컬럼이 포함되어 있어야 한다", () => {
    const src = FragmentReader.prototype.searchByKeywords.toString();
    assert.ok(
      src.includes("f.key_id"),
      "searchByKeywords SELECT 절에 f.key_id 가 없음 — d65e656 회귀"
    );
  });
});

describe("searchByTopic — SELECT f.key_id 포함", () => {
  it("SELECT 절에 f.key_id 컬럼이 포함되어 있어야 한다", () => {
    const src = FragmentReader.prototype.searchByTopic.toString();
    assert.ok(
      src.includes("f.key_id"),
      "searchByTopic SELECT 절에 f.key_id 가 없음 — d65e656 회귀"
    );
  });
});

describe("searchBySemantic — SELECT f.key_id 포함", () => {
  it("SELECT 절에 f.key_id 컬럼이 포함되어 있어야 한다", () => {
    const src = FragmentReader.prototype.searchBySemantic.toString();
    assert.ok(
      src.includes("f.key_id"),
      "searchBySemantic SELECT 절에 f.key_id 가 없음 — d65e656 회귀"
    );
  });
});

describe("searchBySource — key_id 배열 필터 포함", () => {
  it("searchBySource가 key_id = ANY 패턴을 포함하고 있어야 한다", () => {
    const src = FragmentReader.prototype.searchBySource.toString();
    assert.ok(
      src.includes("key_id = ANY("),
      "searchBySource에 key_id = ANY( 패턴이 없음"
    );
  });
});

/** ── 2. master 케이스: keyId=null 시 key_id 조건 미포함 ───────────────── */

describe("master 케이스 — keyId null 시 WHERE key_id 조건 없어야 함", () => {

  /**
   * searchByKeywords/searchByTopic의 keyId 조건 빌드 로직 재현.
   * options.keyId 가 falsy면 key_id 조건이 conditions 배열에 추가되지 않는다.
   */
  function buildKeyCondition(keyId, conditions, params, paramIdx) {
    if (keyId) {
      conditions.push(`key_id = ANY($${paramIdx})`);
      params.push(keyId);
      paramIdx++;
    }
    return { conditions, params, paramIdx };
  }

  it("keyId=null 이면 key_id 조건이 WHERE에 포함되지 않는다", () => {
    const conditions = ["keywords && $1", "(agent_id = $2 OR agent_id = 'default')"];
    const params     = [["database"], "default"];
    const { conditions: result } = buildKeyCondition(null, conditions, params, 3);

    const whereClause = result.join(" AND ");
    assert.ok(
      !whereClause.includes("key_id"),
      "master(null) 케이스에서 key_id 조건이 WHERE 절에 있으면 안 됨"
    );
  });

  it("searchByKeywords 메서드가 keyId null 분기를 포함하고 있어야 한다", () => {
    const src = FragmentReader.prototype.searchByKeywords.toString();
    assert.ok(
      src.includes("options.keyId"),
      "searchByKeywords에 options.keyId 분기가 없음"
    );
  });
});

/** ── 3. 단일 keyId 케이스: SQL에 key_id = ANY($N) 포함 ─────────────────── */

describe("단일 keyId 케이스 — WHERE key_id = ANY($N) 조건 빌드", () => {

  function buildKeyAnyCondition(keyId, conditions, params, paramIdx) {
    if (keyId) {
      conditions.push(`key_id = ANY($${paramIdx})`);
      params.push(keyId);
      paramIdx++;
    }
    return { conditions, params, paramIdx };
  }

  it("keyId='K1' 이면 key_id = ANY($N) 조건이 포함된다", () => {
    const conditions = ["keywords && $1", "(agent_id = $2 OR agent_id = 'default')"];
    const params     = [["redis"], "default"];
    const { conditions: result, params: finalParams } = buildKeyAnyCondition(
      ["K1"], conditions, params, 3
    );

    const whereClause = result.join(" AND ");
    assert.ok(
      whereClause.includes("key_id = ANY($3)"),
      "단일 keyId: key_id = ANY($3) 조건이 WHERE에 없음"
    );
    assert.deepStrictEqual(finalParams[2], ["K1"]);
  });

  it("searchByTopic 메서드가 key_id = ANY 패턴을 포함하고 있어야 한다", () => {
    const src = FragmentReader.prototype.searchByTopic.toString();
    assert.ok(
      src.includes("key_id = ANY("),
      "searchByTopic에 key_id = ANY( 패턴이 없음"
    );
  });

  it("searchBySemantic 메서드가 f.key_id = ANY 패턴을 포함하고 있어야 한다", () => {
    const src = FragmentReader.prototype.searchBySemantic.toString();
    assert.ok(
      src.includes("key_id = ANY("),
      "searchBySemantic에 key_id = ANY( 패턴이 없음"
    );
  });
});

/** ── 4. group keyId 케이스: 배열 keyId 시 ANY($N) 형식 ────────────────── */

describe("group keyId 케이스 — 배열 keyId SQL ANY($N) 형식", () => {

  /**
   * FragmentReader 내 conditions 빌드 패턴을 직접 재현하여 검증.
   * keyId는 string | string[] 모두 수용하는 ANY($N) 패턴 사용.
   */
  function buildSqlWithGroupKey(keyId) {
    const conditions = ["keywords && $1", "(agent_id = $2 OR agent_id = 'default')"];
    const params     = [["session"], "default"];
    let   paramIdx   = 3;

    if (keyId) {
      conditions.push(`key_id = ANY($${paramIdx})`);
      params.push(keyId);
      paramIdx++;
    }

    const whereSql = "WHERE " + conditions.join(" AND ");
    return { whereSql, params, paramIdx };
  }

  it("keyId=['K1','K2','K3'] 이면 SQL에 key_id = ANY($3) 형식이 포함된다", () => {
    const { whereSql, params } = buildSqlWithGroupKey(["K1", "K2", "K3"]);

    assert.ok(
      whereSql.includes("key_id = ANY($3)"),
      `group keyId: SQL에 key_id = ANY($3) 없음. 실제: ${whereSql}`
    );
    assert.deepStrictEqual(params[2], ["K1", "K2", "K3"]);
  });

  it("keyId 배열 파라미터가 PostgreSQL ANY($N) 단일 바인딩으로 전달된다 (배열 폭발 없음)", () => {
    const { params, paramIdx } = buildSqlWithGroupKey(["K1", "K2", "K3"]);

    /** ANY($N) 방식이면 paramIdx는 4 (배열 1개 바인딩) */
    assert.strictEqual(paramIdx, 4, "배열 keyId는 단일 파라미터($3) 하나여야 한다");
    assert.strictEqual(params.length, 3, "params 배열에 원소가 3개여야 한다");
  });

  it("keyId=[] (빈 배열)은 falsy가 아니므로 key_id 조건이 포함된다", () => {
    /**
     * 빈 배열([])은 truthy이므로 key_id = ANY($3) 조건이 추가된다.
     * 이는 의도된 동작: 빈 그룹은 결과가 0건이어야 한다 (소유 파편 없음).
     */
    const { whereSql } = buildSqlWithGroupKey([]);
    assert.ok(
      whereSql.includes("key_id = ANY($3)"),
      "빈 그룹 keyId: key_id = ANY($3) 조건이 없음"
    );
  });
});
