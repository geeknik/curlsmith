import test from "node:test";
import assert from "node:assert/strict";
import {
  payloadStoredSize,
  planPayloadRetention,
  selectCaptureIdsForRetention,
  stripEvictedPayloadRefs
} from "../../src/background/capture-store.js";

test("record retention selects oldest and expired captures", () => {
  const oneHour = 60 * 60 * 1000;
  const now = 4 * oneHour;
  const captures = Array.from({ length: 11 }, (_, index) => ({
    id: `cap:${index}`,
    startedAt: now - index * 1_000
  }));
  captures.push({ id: "expired", startedAt: now - 2 * oneHour });

  const deleteIds = selectCaptureIdsForRetention(captures, now, {
    maxRecords: 10,
    ttlMs: oneHour
  });

  assert.deepEqual(deleteIds, ["cap:10", "expired"]);
});

test("payload retention evicts oldest bodies until total cap is satisfied", () => {
  const captures = [
    { id: "cap:old", startedAt: 1 },
    { id: "cap:new", startedAt: 2 }
  ];
  const payloads = [
    { id: "payload:old:request", captureId: "cap:old", role: "request", storedSize: 20 },
    { id: "payload:old:response", captureId: "cap:old", role: "response", storedSize: 50 },
    { id: "payload:new:response", captureId: "cap:new", role: "response", storedSize: 40 }
  ];

  const plan = planPayloadRetention(captures, payloads, 80);

  assert.equal(plan.totalBytes, 110);
  assert.deepEqual(plan.evictions.map((eviction) => eviction.payloadId), ["payload:old:response"]);
});

test("payload size falls back to actual bytes and UTF-8 text length", () => {
  assert.equal(payloadStoredSize({ bytes: new Uint8Array([1, 2, 3]) }), 3);
  assert.equal(payloadStoredSize({ text: "curlsmith" }), 9);
});

test("evicted payload references are stripped without leaking previews", () => {
  const capture = {
    id: "cap:test",
    request: {
      body: {
        kind: "json",
        storageKey: "payload:cap:test:request",
        byteLength: 32,
        capturedByteLength: 32,
        truncated: false,
        sha256: "abc123",
        charset: "utf-8",
        preview: "{\"access_token\":\"secret-token-value\"}"
      }
    },
    response: {
      body: {
        kind: "json",
        storageKey: "payload:cap:test:response",
        byteLength: 64,
        capturedByteLength: 64,
        truncated: false,
        preview: "{\"ok\":true}"
      }
    },
    replay: { warnings: [] },
    classification: { labels: [] }
  };

  const stripped = stripEvictedPayloadRefs(capture, new Set(["payload:cap:test:request"]));

  assert.equal(stripped.request.body.storageKey, undefined);
  assert.equal(stripped.request.body.capturedByteLength, 0);
  assert.equal(stripped.request.body.truncated, true);
  assert.equal(stripped.request.body.sha256, "abc123");
  assert.equal(stripped.request.body.preview, "[payload evicted by retention policy]");
  assert.equal(stripped.response.body.storageKey, "payload:cap:test:response");
  assert.equal(stripped.replay.warnings.includes("payload_retention_omitted"), true);
  assert.equal(stripped.classification.labels.includes("metadataOnly"), true);
});
