import { escapeId, buildSearchPath } from "../../lib/config.js";
import assert from "node:assert";
import { test } from "node:test";

test("escapeId safely escapes PostgreSQL identifiers", () => {
  assert.strictEqual(escapeId("public"), '"public"');
  assert.strictEqual(escapeId("agent_memory"), '"agent_memory"');
  assert.strictEqual(escapeId('my_schema"'), '"my_schema"""');
  assert.strictEqual(escapeId('schema"; DROP TABLE users; --'), '"schema""; DROP TABLE users; --"');
});

test("buildSearchPath uses escaped identifiers", () => {
  const path = buildSearchPath("my_schema");
  // buildSearchPath always includes public at the end, and potentially PGVECTOR_SCHEMA
  assert.match(path, /SET search_path TO "my_schema"/);
  assert.match(path, /"public"/);
});
