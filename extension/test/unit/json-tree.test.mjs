import test from "node:test";
import assert from "node:assert/strict";
import { jsonTreeRows, jsonTreeRowsFromText } from "../../src/shared/json-tree.js";

test("json tree rows flatten objects with paths and previews", () => {
  const rows = jsonTreeRows({
    user: {
      id: "u1",
      name: "Alice"
    }
  });

  assert.equal(rows[0].path, "$");
  assert.equal(rows[1].path, "$.user");
  assert.equal(rows[2].path, "$.user.id");
  assert.equal(rows[2].preview, "\"u1\"");
});

test("json tree rows skip prototype pollution keys", () => {
  const rows = jsonTreeRows({
    "__proto__": { polluted: true },
    safe: true
  });

  assert.equal(rows.some((row) => row.key === "__proto__"), false);
  assert.equal(rows.some((row) => row.key === "safe"), true);
});

test("json tree rows enforce node cap", () => {
  const rows = jsonTreeRows(Array.from({ length: 10 }, (_, index) => index), { maxNodes: 4 });
  assert.equal(rows.some((row) => row.kind === "truncated"), true);
});

test("json tree rows parse text", () => {
  const rows = jsonTreeRowsFromText("{\"ok\":true}");
  assert.equal(rows[1].path, "$.ok");
  assert.equal(rows[1].preview, "true");
});
