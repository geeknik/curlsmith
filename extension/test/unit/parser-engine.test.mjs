import test from "node:test";
import assert from "node:assert/strict";
import { extractEntitiesFromJson, extractEntitiesFromText } from "../../src/shared/parser-engine.js";

const capture = {
  id: "cap:test",
  request: {
    host: "api.example.test",
    url: "https://api.example.test/v1/posts"
  }
};

test("parser extracts entity-like JSON objects with provenance", () => {
  const entities = extractEntitiesFromJson({
    data: {
      posts: [
        {
          id: "p1",
          title: "Hello",
          body: "World",
          author: "alice",
          created_at: "2026-05-02"
        }
      ]
    }
  }, capture);

  assert.equal(entities.length, 1);
  assert.equal(entities[0].type, "post");
  assert.equal(entities[0].externalId, "p1");
  assert.equal(entities[0].rawPath, "$.data.posts[0]");
});

test("parser respects entity cap", () => {
  const items = Array.from({ length: 10 }, (_, index) => ({
    id: `p${index}`,
    title: `Post ${index}`,
    body: "x"
  }));

  const entities = extractEntitiesFromJson({ items }, capture, { maxEntities: 3 });
  assert.equal(entities.length, 3);
});

test("parser extracts entities from NDJSON text with line provenance", () => {
  const text = [
    JSON.stringify({ id: "m1", message: "hello", sender: "alice", timestamp: "2026-05-02T12:20:00Z" }),
    JSON.stringify({ id: "m2", message: "world", sender: "bob", timestamp: "2026-05-02T12:21:00Z" })
  ].join("\n");

  const entities = extractEntitiesFromText(text, capture);
  assert.equal(entities.length, 2);
  assert.equal(entities[0].type, "message");
  assert.equal(entities[0].rawPath, "$[0]");
});

test("parser fails closed on malformed NDJSON text", () => {
  const text = `${JSON.stringify({ id: "m1", message: "hello", sender: "alice" })}\nnot-json`;
  assert.deepEqual(extractEntitiesFromText(text, capture), []);
});
