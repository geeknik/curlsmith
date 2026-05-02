import test from "node:test";
import assert from "node:assert/strict";
import { entitiesToCsv, entitiesToJsonl, normalizeEntityForExport } from "../../src/shared/entity-export.js";

const entity = {
  id: "ent:1",
  sourceCaptureId: "cap:1",
  sourceHost: "api.example.test",
  sourceUrl: "https://api.example.test/messages",
  type: "message",
  externalId: "m1",
  author: "alice",
  text: "hello fakeTokenValueThatIsLongEnoughForRedaction",
  rawPath: "$.messages[0]",
  confidence: 0.842123,
  raw: {
    access_token: "fake-token-value"
  }
};

test("entity export normalization omits raw captured objects", () => {
  const normalized = normalizeEntityForExport(entity);
  assert.equal(Object.hasOwn(normalized, "raw"), false);
  assert.equal(normalized.confidence, 0.842);
});

test("entity JSONL export redacts token-like text", () => {
  const jsonl = entitiesToJsonl([entity]);
  assert.match(jsonl, /<REDACTED>/);
  assert.doesNotMatch(jsonl, /fakeTokenValueThatIsLongEnoughForRedaction/);
  assert.doesNotMatch(jsonl, /access_token/);
});

test("entity CSV export escapes comma and quote values", () => {
  const csv = entitiesToCsv([{
    ...entity,
    title: "Hello, \"world\""
  }]);

  assert.match(csv, /"Hello, ""world"""/);
  assert.doesNotMatch(csv, /access_token/);
});
