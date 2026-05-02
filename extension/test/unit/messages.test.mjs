import test from "node:test";
import assert from "node:assert/strict";
import { validateMessage } from "../../src/shared/messages.js";

test("message validation accepts exact known schemas", () => {
  const message = validateMessage({
    action: "GENERATE_CURL",
    id: "cap:abc-123",
    profile: "pretty-redacted",
    revealSecrets: false
  });

  assert.equal(message.action, "GENERATE_CURL");
});

test("message validation accepts supported cURL profiles", () => {
  for (const profile of ["binary-file", "powershell", "fish"]) {
    const message = validateMessage({
      action: "GENERATE_CURL",
      id: "cap:abc-123",
      profile,
      revealSecrets: false
    });
    assert.equal(message.profile, profile);
  }
});

test("message validation rejects unknown fields", () => {
  assert.throws(() => validateMessage({
    action: "PURGE_ALL",
    extra: true
  }), /Unexpected message field/);
});

test("message validation rejects invalid capture IDs", () => {
  assert.throws(() => validateMessage({
    action: "GET_CAPTURE",
    id: "../secret"
  }), /Invalid message field/);
});

test("message validation accepts exact capture scope changes", () => {
  const message = validateMessage({
    action: "SET_CAPTURE_SCOPE",
    mode: "current-site",
    originPattern: "https://example.test/*"
  });

  assert.equal(message.mode, "current-site");
});

test("message validation rejects malformed capture scope origins", () => {
  assert.throws(() => validateMessage({
    action: "SET_CAPTURE_SCOPE",
    mode: "current-site",
    originPattern: "file:///tmp/*"
  }), /Invalid message field/);
});

test("message validation accepts bounded retention settings", () => {
  const message = validateMessage({
    action: "UPDATE_SETTINGS",
    maxRecords: 1000,
    ttlMs: 24 * 60 * 60 * 1000,
    maxTotalPayloadBytes: 100 * 1024 * 1024,
    maxRequestBodyBytes: 512 * 1024,
    maxResponseBodyBytes: 2 * 1024 * 1024
  });

  assert.equal(message.maxRecords, 1000);
});

test("message validation rejects excessive retention settings", () => {
  assert.throws(() => validateMessage({
    action: "UPDATE_SETTINGS",
    maxTotalPayloadBytes: 1024 * 1024 * 1024 + 1
  }), /Invalid message field/);

  assert.throws(() => validateMessage({
    action: "UPDATE_SETTINGS",
    maxResponseBodyBytes: 6 * 1024 * 1024
  }), /Invalid message field/);
});
