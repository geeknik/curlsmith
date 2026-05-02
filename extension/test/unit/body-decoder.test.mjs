import test from "node:test";
import assert from "node:assert/strict";
import { describeBody, hasBinarySignals } from "../../src/shared/body-decoder.js";

test("JSON body samples are classified as JSON", async () => {
  const bytes = new TextEncoder().encode("{\"ok\":true}");
  const body = await describeBody({
    bytes,
    totalBytes: bytes.byteLength,
    truncated: false,
    headers: [{ name: "Content-Type", value: "application/json" }]
  });

  assert.equal(body.kind, "json");
  assert.equal(body.preview, "{\"ok\":true}");
  assert.equal(body.truncated, false);
});

test("binary body samples avoid text decoding", async () => {
  const body = await describeBody({
    bytes: new Uint8Array([1, 0, 2]),
    totalBytes: 3,
    truncated: false,
    headers: [{ name: "Content-Type", value: "application/octet-stream" }]
  });

  assert.equal(body.kind, "binary");
  assert.match(body.preview, /binary body sample/);
});

test("binary signal detection catches opaque upload bytes", () => {
  assert.equal(hasBinarySignals(new Uint8Array([0x08, 0x96, 0x01, 0x00, 0xff])), true);
  assert.equal(hasBinarySignals(new TextEncoder().encode("{\"ok\":true}")), false);
});
