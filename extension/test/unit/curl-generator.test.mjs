import test from "node:test";
import assert from "node:assert/strict";
import { generateCurl } from "../../src/shared/curl-generator.js";

function capture() {
  return {
    id: "cap:test",
    request: {
      method: "POST",
      url: "https://api.example.test/v1/posts?access_token=query-secret-token-value&limit=1",
      headers: [
        { name: "Accept", value: "application/json", source: "request" },
        { name: "Authorization", value: "Bearer header-secret-token-value", source: "request" },
        { name: "Content-Type", value: "application/json", source: "request" },
        { name: "Content-Length", value: "12", source: "request" }
      ],
      body: {
        kind: "json",
        truncated: false
      }
    }
  };
}

test("redacted cURL hides headers and query secrets", () => {
  const result = generateCurl(capture(), {
    profile: "pretty-redacted",
    revealSecrets: false,
    requestBodyText: "{\"ok\":true,\"access_token\":\"body-secret-token-value\"}"
  });

  assert.match(result.command, /Authorization: Bearer <REDACTED>|Authorization: <REDACTED>/);
  assert.doesNotMatch(result.command, /header-secret/);
  assert.doesNotMatch(result.command, /query-secret/);
  assert.doesNotMatch(result.command, /body-secret/);
  assert.match(result.command, /limit=1/);
  assert.deepEqual(result.warnings.includes("authorization_redacted"), true);
});

test("full profile does not reveal secrets without explicit reveal flag", () => {
  const result = generateCurl(capture(), {
    profile: "pretty-full",
    revealSecrets: false,
    requestBodyText: "{\"ok\":true}"
  });

  assert.doesNotMatch(result.command, /header-secret/);
  assert.doesNotMatch(result.command, /query-secret/);
});

test("explicit reveal flag restores non-cookie secrets", () => {
  const result = generateCurl(capture(), {
    profile: "pretty-full",
    revealSecrets: true,
    requestBodyText: "{\"ok\":true,\"access_token\":\"body-secret-token-value\"}"
  });

  assert.match(result.command, /header-secret-token-value/);
  assert.match(result.command, /query-secret-token-value/);
  assert.match(result.command, /body-secret-token-value/);
});

test("binary request bodies are not emitted as data-raw", () => {
  const item = capture();
  item.request.body = {
    kind: "binary",
    truncated: false
  };

  const result = generateCurl(item, {
    profile: "pretty-redacted",
    revealSecrets: false,
    requestBodyText: ""
  });

  assert.doesNotMatch(result.command, /--data-raw/);
  assert.equal(result.warnings.includes("binary_body_requires_export"), true);
});

test("capture replay warnings are preserved in cURL result", () => {
  const item = capture();
  item.replay = {
    warnings: ["redirect_chain_present"]
  };

  const result = generateCurl(item, {
    profile: "pretty-redacted",
    revealSecrets: false,
    requestBodyText: ""
  });

  assert.equal(result.warnings.includes("redirect_chain_present"), true);
});
