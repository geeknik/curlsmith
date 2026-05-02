import test from "node:test";
import assert from "node:assert/strict";
import { isSensitiveHeaderName, redactHeader, redactJsonValue, redactUrl } from "../../src/shared/redactor.js";

test("sensitive headers are detected case-insensitively", () => {
  assert.equal(isSensitiveHeaderName("Authorization"), true);
  assert.equal(isSensitiveHeaderName("x-api-key"), true);
  assert.equal(isSensitiveHeaderName("Accept"), false);
});

test("redacted headers retain names and hide values", () => {
  assert.deepEqual(redactHeader({ name: "Authorization", value: "Bearer secret" }, false), {
    name: "Authorization",
    value: "<REDACTED>",
    redacted: true
  });
});

test("JSON redaction skips prototype pollution keys", () => {
  const input = {
    token: "abc123abc123abc123abc123",
    nested: {
      password: "secret",
      ok: "value"
    },
    "__proto__": {
      polluted: true
    }
  };
  const output = redactJsonValue(input);
  assert.equal(output.token, "<REDACTED>");
  assert.equal(output.nested.password, "<REDACTED>");
  assert.equal(output.nested.ok, "value");
  assert.equal(Object.hasOwn(output, "__proto__"), false);
});

test("URL redaction preserves non-secret query values", () => {
  const output = redactUrl("https://example.test/api?token=secretsecretsecretsecret&limit=20", false);
  assert.equal(output, "https://example.test/api?token=%3CREDACTED%3E&limit=20");
});
