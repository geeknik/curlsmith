import test from "node:test";
import assert from "node:assert/strict";
import { shSingleQuote } from "../../src/shared/shell-escape.js";

test("POSIX single quote escaping uses close-escape-reopen form", () => {
  assert.equal(shSingleQuote("a'b"), "'a'\\''b'");
});

test("POSIX single quote escaping preserves empty strings", () => {
  assert.equal(shSingleQuote(""), "''");
});
