import test from "node:test";
import assert from "node:assert/strict";
import { CaptureController, metadataOnlyCapture } from "../../src/background/capture-controller.js";
import { CAPTURE_MODE } from "../../src/shared/constants.js";

function controller() {
  return new CaptureController({});
}

test("request body capture keeps opaque raw upload bytes binary", () => {
  const ctl = controller();
  const result = ctl.captureRequestBody("cap:test", {
    raw: [
      {
        bytes: new Uint8Array([0x08, 0x96, 0x01, 0x00, 0xff]).buffer
      }
    ]
  });

  assert.equal(result.bodyRef.kind, "binary");
  assert.equal(result.payload.text, undefined);
  assert.ok(result.payload.bytes instanceof ArrayBuffer);
});

test("request body capture keeps UTF-8 upload bytes textual", () => {
  const ctl = controller();
  const result = ctl.captureRequestBody("cap:test", {
    raw: [
      {
        bytes: new TextEncoder().encode("{\"ok\":true}").buffer
      }
    ]
  });

  assert.equal(result.bodyRef.kind, "unknown");
  assert.equal(result.payload.text, "{\"ok\":true}");
});

test("capture scope requires host permission and matching current site", () => {
  const ctl = controller();
  ctl.permissions = { isApproved: () => true };
  ctl.settings = {
    ...ctl.settings,
    captureEnabled: true,
    captureMode: CAPTURE_MODE.CURRENT_SITE,
    scopedOriginPattern: "https://api.example.test/*"
  };

  assert.equal(ctl.shouldConsider({
    url: "https://api.example.test/api/users",
    tabId: 4
  }), true);
  assert.equal(ctl.shouldConsider({
    url: "https://other.example.test/api/users",
    tabId: 4
  }), false);
});

test("capture scope current tab narrows approved captures by tab id", () => {
  const ctl = controller();
  ctl.permissions = { isApproved: () => true };
  ctl.settings = {
    ...ctl.settings,
    captureEnabled: true,
    captureMode: CAPTURE_MODE.CURRENT_TAB,
    scopedTabId: 42
  };

  assert.equal(ctl.shouldConsider({
    url: "https://api.example.test/api/users",
    tabId: 42
  }), true);
  assert.equal(ctl.shouldConsider({
    url: "https://api.example.test/api/users",
    tabId: 43
  }), false);
});

test("capture scope still fails closed without host permission", () => {
  const ctl = controller();
  ctl.permissions = { isApproved: () => false };
  ctl.settings = {
    ...ctl.settings,
    captureEnabled: true,
    captureMode: CAPTURE_MODE.APPROVED_SITES
  };

  assert.equal(ctl.shouldConsider({
    url: "https://api.example.test/api/users",
    tabId: 1
  }), false);
});

test("redirect events record chain metadata and replay warning", () => {
  const ctl = controller();
  const capture = ctl.createCapture({
    requestId: "r1",
    url: "https://api.example.test/api/redirect",
    method: "GET",
    tabId: 1,
    frameId: 0,
    type: "xmlhttprequest",
    timeStamp: 1
  }, 5);
  ctl.pending.set("r1", {
    capture,
    payloads: [],
    entities: [],
    filterAttached: false,
    responseDone: true,
    completed: false,
    stored: false,
    responseHeaders: []
  });

  ctl.onBeforeRedirect({
    requestId: "r1",
    url: "https://api.example.test/api/redirect",
    redirectUrl: "https://api.example.test/api/users"
  });

  assert.equal(capture.redirect.toUrl, "https://api.example.test/api/users");
  assert.equal(capture.replay.warnings.includes("redirect_chain_present"), true);
});

test("metadata-only fallback removes payload references and previews", () => {
  const ctl = controller();
  const capture = ctl.createCapture({
    requestId: "r1",
    url: "https://api.example.test/api/posts",
    method: "POST",
    tabId: 1,
    frameId: 0,
    type: "xmlhttprequest",
    timeStamp: 1
  }, 5);
  capture.request.body = {
    kind: "json",
    storageKey: "payload:cap:request",
    byteLength: 30,
    capturedByteLength: 30,
    truncated: false,
    preview: "{\"access_token\":\"secret\"}"
  };
  capture.response = {
    headers: [],
    body: {
      kind: "json",
      storageKey: "payload:cap:response",
      byteLength: 50,
      capturedByteLength: 50,
      truncated: false,
      preview: "{\"ok\":true}"
    }
  };

  const fallback = metadataOnlyCapture(capture);
  assert.equal(fallback.request.body.storageKey, undefined);
  assert.equal(fallback.request.body.preview, "[payload omitted after storage failure]");
  assert.equal(fallback.response.body.storageKey, undefined);
  assert.equal(fallback.error.source, "storage");
  assert.equal(fallback.replay.warnings.includes("storage_metadata_only"), true);
});

test("persistence retries after eviction before falling back", async () => {
  const calls = [];
  const ctl = new CaptureController({
    async putCapture(capture, payloads, entities) {
      calls.push({ capture, payloads, entities });
      if (calls.length === 1) {
        throw new Error("quota");
      }
    },
    async evictOldestCaptures(count) {
      assert.equal(count, 100);
      return 1;
    },
    async enforceRetention() {
      throw new Error("should not be called");
    }
  });
  const state = {
    capture: ctl.createCapture({
      requestId: "r1",
      url: "https://api.example.test/api/posts",
      method: "GET",
      tabId: 1,
      frameId: 0,
      type: "xmlhttprequest",
      timeStamp: 1
    }, 5),
    payloads: [{ id: "payload:1" }],
    entities: [{ id: "ent:1" }]
  };

  assert.equal(await ctl.persistWithFallback(state), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].payloads.length, 1);
});

test("persistence stores metadata-only record after retry failure", async () => {
  const calls = [];
  const ctl = new CaptureController({
    async putCapture(capture, payloads, entities) {
      calls.push({ capture, payloads, entities });
      if (calls.length < 3) {
        throw new Error("quota");
      }
    },
    async evictOldestCaptures() {
      return 0;
    },
    async enforceRetention() {}
  });
  const state = {
    capture: ctl.createCapture({
      requestId: "r1",
      url: "https://api.example.test/api/posts",
      method: "GET",
      tabId: 1,
      frameId: 0,
      type: "xmlhttprequest",
      timeStamp: 1
    }, 5),
    payloads: [{ id: "payload:1" }],
    entities: [{ id: "ent:1" }]
  };
  state.capture.response = {
    headers: [],
    body: {
      kind: "json",
      storageKey: "payload:1",
      byteLength: 10,
      capturedByteLength: 10,
      truncated: false,
      preview: "{\"ok\":true}"
    }
  };

  assert.equal(await ctl.persistWithFallback(state), true);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].payloads.length, 0);
  assert.equal(calls[2].entities.length, 0);
  assert.equal(calls[2].capture.response.body.storageKey, undefined);
  assert.equal(calls[2].capture.classification.labels.includes("metadataOnly"), true);
});

test("retention setting updates trigger retention enforcement", async () => {
  let enforced = false;
  const ctl = new CaptureController({
    async updateSettings(patch) {
      return { ...ctl.settings, ...patch };
    },
    async enforceRetention(settings) {
      enforced = true;
      assert.equal(settings.maxRecords, 50);
    }
  });

  const result = await ctl.handleMessage({
    action: "UPDATE_SETTINGS",
    maxRecords: 50
  });

  assert.equal(result.settings.maxRecords, 50);
  assert.equal(enforced, true);
});
