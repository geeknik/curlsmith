import {
  API_REQUEST_TYPES,
  BODY_KIND,
  CAPTURE_MODE,
  CAPTURE_STATE,
  DEFAULT_SETTINGS,
  JSON_CONTENT_TYPE_PATTERN
} from "../shared/constants.js";
import { concatArrayBuffers, decodeText, getHeader, hasBinarySignals, parseContentType } from "../shared/body-decoder.js";
import { generateCurl } from "../shared/curl-generator.js";
import { hostFromUrl, isHttpUrl, matchesApprovedOrigin } from "../shared/match-pattern.js";
import { validateMessage } from "../shared/messages.js";
import { extractEntitiesFromText } from "../shared/parser-engine.js";
import { isSensitiveHeaderName, isSensitiveKey } from "../shared/redactor.js";
import { PermissionTracker } from "./permissions.js";
import { attachResponseFilter, buildResponsePayload } from "./stream-tee.js";

const LISTENER_FILTER = { urls: ["<all_urls>"] };
const REQUEST_OPTIONS = ["blocking", "requestBody"];
const REQUEST_HEADER_OPTIONS = ["requestHeaders"];
const RESPONSE_HEADER_OPTIONS = ["responseHeaders"];

export class CaptureController {
  constructor(store) {
    this.store = store;
    this.permissions = new PermissionTracker();
    this.settings = { ...DEFAULT_SETTINGS };
    this.pending = new Map();
    this.started = false;
    this.completedSinceRetention = 0;
  }

  async start() {
    if (this.started) {
      return;
    }
    this.started = true;
    this.registerListeners();
    this.permissions.watch(() => {});
    this.settings = await this.store.getSettings();
    await this.permissions.refresh();
    await this.store.enforceRetention(this.settings);
  }

  registerListeners() {
    browser.webRequest.onBeforeRequest.addListener(
      (details) => this.onBeforeRequest(details),
      LISTENER_FILTER,
      REQUEST_OPTIONS
    );
    browser.webRequest.onBeforeSendHeaders.addListener(
      (details) => this.onBeforeSendHeaders(details),
      LISTENER_FILTER,
      REQUEST_HEADER_OPTIONS
    );
    browser.webRequest.onHeadersReceived.addListener(
      (details) => this.onHeadersReceived(details),
      LISTENER_FILTER,
      RESPONSE_HEADER_OPTIONS
    );
    browser.webRequest.onCompleted.addListener(
      (details) => this.onCompleted(details),
      LISTENER_FILTER
    );
    browser.webRequest.onBeforeRedirect.addListener(
      (details) => this.onBeforeRedirect(details),
      LISTENER_FILTER
    );
    browser.webRequest.onErrorOccurred.addListener(
      (details) => this.onErrorOccurred(details),
      LISTENER_FILTER
    );
  }

  onBeforeRequest(details) {
    if (!this.shouldConsider(details)) {
      return {};
    }

    const score = this.scoreEarly(details);
    if (score <= 0) {
      return {};
    }

    const capture = this.createCapture(details, score);
    const state = {
      capture,
      payloads: [],
      entities: [],
      filterAttached: false,
      responseDone: true,
      completed: false,
      stored: false,
      responseHeaders: []
    };

    const requestBody = this.captureRequestBody(capture.id, details.requestBody);
    if (requestBody) {
      capture.request.body = requestBody.bodyRef;
      state.payloads.push(requestBody.payload);
    }

    this.pending.set(details.requestId, state);

    if (this.activeFilteredCount() < this.settings.maxConcurrentFilteredRequests) {
      try {
        state.responseDone = false;
        state.filterAttached = true;
        attachResponseFilter({
          requestId: details.requestId,
          maxBytes: this.settings.maxResponseBodyBytes,
          responseHeaders: [],
          onStop: (snapshot) => {
            void this.onResponseBodyReady(details.requestId, snapshot);
          },
          onError: (message) => {
            this.markError(details.requestId, "responseFilter", message);
          }
        });
      } catch {
        state.responseDone = true;
        capture.classification.labels.push(CAPTURE_STATE.METADATA_ONLY);
        capture.error = {
          source: "responseFilter",
          message: "Response filter could not be created."
        };
      }
    } else {
      capture.classification.labels.push(CAPTURE_STATE.METADATA_ONLY);
      capture.replay.warnings.push("capture_degraded_metadata_only");
    }

    return {};
  }

  onBeforeSendHeaders(details) {
    const state = this.pending.get(details.requestId);
    if (!state) {
      return {};
    }

    state.capture.request.headers = normalizeHeaderEntries(details.requestHeaders || [], "request");
    if (state.capture.request.body) {
      const contentType = getHeader(state.capture.request.headers, "content-type");
      const preview = state.capture.request.body.preview || "";
      if (state.capture.request.body.kind === BODY_KIND.BINARY) {
        // Preserve binary classification. Do not reinterpret opaque upload bytes as text.
      } else if (JSON_CONTENT_TYPE_PATTERN.test(contentType) || preview.trimStart().startsWith("{") || preview.trimStart().startsWith("[")) {
        state.capture.request.body.kind = BODY_KIND.JSON;
      } else if (/application\/x-www-form-urlencoded/i.test(contentType)) {
        state.capture.request.body.kind = BODY_KIND.FORM;
      } else if (/multipart\/form-data/i.test(contentType)) {
        state.capture.request.body.kind = BODY_KIND.MULTIPART;
      }
    }
    return {};
  }

  onHeadersReceived(details) {
    const state = this.pending.get(details.requestId);
    if (!state) {
      return {};
    }

    const headers = normalizeHeaderEntries(details.responseHeaders || [], "response");
    state.responseHeaders = headers;
    const contentType = getHeader(headers, "content-type");
    const { charset } = parseContentType(headers);
    state.capture.response = {
      statusCode: details.statusCode,
      statusLine: details.statusLine,
      headers,
      contentType,
      mime: contentType.split(";")[0] || undefined,
      charset
    };

    const lateScore = this.scoreLate(details, contentType);
    state.capture.classification.apiScore += lateScore;
    if (JSON_CONTENT_TYPE_PATTERN.test(contentType)) {
      state.capture.classification.labels.push("json");
    }

    return {};
  }

  onBeforeRedirect(details) {
    const state = this.pending.get(details.requestId);
    if (!state) {
      return;
    }

    state.capture.redirect = {
      fromRequestId: String(details.requestId),
      chainId: `redirect:${details.requestId}`,
      fromUrl: details.url,
      toUrl: details.redirectUrl
    };
    state.capture.replay.warnings.push("redirect_chain_present");
    state.capture.classification.labels.push("redirect");
  }

  onCompleted(details) {
    const state = this.pending.get(details.requestId);
    if (!state) {
      return;
    }

    state.capture.completedAt = details.timeStamp || Date.now();
    state.completed = true;
    void this.maybePersist(details.requestId);
  }

  onErrorOccurred(details) {
    const state = this.pending.get(details.requestId);
    if (!state) {
      return;
    }

    state.capture.completedAt = details.timeStamp || Date.now();
    state.capture.error = {
      source: "request",
      message: "Request failed."
    };
    state.capture.classification.labels.push(CAPTURE_STATE.ERRORED);
    state.completed = true;
    state.responseDone = true;
    void this.maybePersist(details.requestId);
  }

  async onResponseBodyReady(requestId, snapshot) {
    const state = this.pending.get(requestId);
    if (!state) {
      return;
    }

    try {
      const { bodyRef, payload } = await buildResponsePayload({
        captureId: state.capture.id,
        snapshot,
        headers: state.responseHeaders,
        maxPreviewChars: this.settings.maxPreviewChars
      });

      if (!state.capture.response) {
        state.capture.response = { headers: [] };
      }
      state.capture.response.body = bodyRef;
      state.payloads.push(payload);

      if (bodyRef.truncated) {
        state.capture.classification.labels.push(CAPTURE_STATE.TRUNCATED);
      } else if (bodyRef.kind === BODY_KIND.BINARY) {
        state.capture.classification.labels.push(CAPTURE_STATE.BINARY);
      } else {
        state.capture.classification.labels.push(CAPTURE_STATE.CAPTURED);
      }

      if (this.settings.parserEnabled && payload.text && bodyRef.kind === BODY_KIND.JSON) {
        state.entities = extractEntitiesFromText(payload.text, state.capture, {
          maxDepth: this.settings.parserMaxDepth,
          maxEntities: this.settings.parserMaxEntities
        });
      }
    } catch {
      state.capture.error = {
        source: "decoder",
        message: "Captured response could not be decoded."
      };
    } finally {
      state.responseDone = true;
      void this.maybePersist(requestId);
    }
  }

  markError(requestId, source, message) {
    const state = this.pending.get(requestId);
    if (!state) {
      return;
    }

    state.capture.error = {
      source,
      message: String(message || "Capture error.")
    };
    state.capture.classification.labels.push(CAPTURE_STATE.ERRORED);
    state.capture.completedAt = Date.now();
    state.completed = true;
    state.responseDone = true;
    void this.maybePersist(requestId);
  }

  async maybePersist(requestId) {
    const state = this.pending.get(requestId);
    if (!state || state.stored || !state.completed || !state.responseDone) {
      return;
    }

    state.stored = true;
    state.capture.replay.curlProfiles = ["pretty-redacted", "compact-redacted"];

    let stored = false;
    try {
      stored = await this.persistWithFallback(state);
      this.completedSinceRetention += 1;
      if (this.completedSinceRetention >= 20) {
        this.completedSinceRetention = 0;
        await this.store.enforceRetention(this.settings);
      }
    } catch {
      // Captured traffic may contain secrets; do not log the failed record.
    } finally {
      if (stored) {
        void browser.runtime.sendMessage({ action: "CAPTURES_UPDATED" }).catch(() => {});
      }
      this.pending.delete(requestId);
    }
  }

  async persistWithFallback(state) {
    try {
      await this.store.putCapture(state.capture, state.payloads, state.entities);
      return true;
    } catch {
      try {
        await this.freeStorageForRetry();
      } catch {
        // Continue to metadata-only fallback if cleanup itself fails.
      }
    }

    try {
      await this.store.putCapture(state.capture, state.payloads, state.entities);
      return true;
    } catch {
      const metadataOnly = metadataOnlyCapture(state.capture);
      try {
        await this.store.putCapture(metadataOnly, [], []);
        return true;
      } catch {
        return false;
      }
    }
  }

  async freeStorageForRetry() {
    if (typeof this.store.evictOldestCaptures === "function") {
      const evicted = await this.store.evictOldestCaptures(100);
      if (evicted > 0) {
        return;
      }
    }

    await this.store.enforceRetention({
      ...this.settings,
      maxRecords: Math.max(10, Math.floor((this.settings.maxRecords || DEFAULT_SETTINGS.maxRecords) * 0.8))
    });
  }

  shouldConsider(details) {
    if (!details || !isHttpUrl(details.url)) {
      return false;
    }
    if (!this.permissions.isApproved(details.url)) {
      return false;
    }

    const mode = this.getCaptureMode();
    if (mode === CAPTURE_MODE.OFF) {
      return false;
    }

    if (mode === CAPTURE_MODE.CURRENT_TAB) {
      return details.tabId === this.settings.scopedTabId;
    }

    if (mode === CAPTURE_MODE.CURRENT_SITE) {
      return typeof this.settings.scopedOriginPattern === "string" &&
        matchesApprovedOrigin(this.settings.scopedOriginPattern, details.url);
    }

    return mode === CAPTURE_MODE.APPROVED_SITES;
  }

  getCaptureMode() {
    if (!this.settings.captureEnabled) {
      return CAPTURE_MODE.OFF;
    }

    if (Object.values(CAPTURE_MODE).includes(this.settings.captureMode)) {
      return this.settings.captureMode;
    }

    return CAPTURE_MODE.APPROVED_SITES;
  }

  scoreEarly(details) {
    let score = 0;
    const url = new URL(details.url);
    const method = String(details.method || "GET").toUpperCase();
    const path = url.pathname.toLowerCase();

    if (API_REQUEST_TYPES.has(details.type)) {
      score += 4;
    }

    if (hasApiPathMarker(path)) {
      score += 3;
    }

    if (method !== "GET" && method !== "HEAD") {
      score += pathLooksCollectionEndpoint(path) ? 2 : 1;
    }

    if (details.requestBody) {
      score += pathLooksCollectionEndpoint(path) ? 2 : 1;
    }

    return score >= 2 ? score : 0;
  }

  scoreLate(details, contentType) {
    let score = 0;
    if (JSON_CONTENT_TYPE_PATTERN.test(contentType)) {
      score += 4;
    }
    if (details.statusCode >= 200 && details.statusCode < 500) {
      score += 1;
    }
    return score;
  }

  createCapture(details, apiScore) {
    const url = new URL(details.url);
    const query = Array.from(url.searchParams.entries()).map(([name, value]) => ({
      name,
      value,
      redacted: isSensitiveKey(name, value)
    }));

    return {
      id: createCaptureId(),
      requestId: String(details.requestId),
      tabId: details.tabId,
      frameId: details.frameId,
      parentFrameId: details.parentFrameId,
      type: String(details.type || "unknown"),
      startedAt: details.timeStamp || Date.now(),
      request: {
        method: String(details.method || "GET").toUpperCase(),
        url: details.url,
        scheme: url.protocol === "https:" ? "https" : "http",
        host: hostFromUrl(details.url),
        path: url.pathname,
        query,
        headers: []
      },
      replay: {
        curlProfiles: [],
        warnings: []
      },
      classification: {
        apiScore,
        labels: [],
        matchedRules: []
      }
    };
  }

  captureRequestBody(captureId, requestBody) {
    if (!requestBody) {
      return null;
    }

    if (requestBody.formData && typeof requestBody.formData === "object") {
      const params = new URLSearchParams();
      for (const [key, values] of Object.entries(requestBody.formData)) {
        if (Array.isArray(values)) {
          for (const value of values) {
            params.append(key, String(value));
          }
        }
      }
      const text = params.toString();
      return this.buildRequestTextPayload(captureId, text, BODY_KIND.FORM, false, text.length);
    }

    if (Array.isArray(requestBody.raw)) {
      const chunks = [];
      let sawFile = false;
      for (const part of requestBody.raw) {
        if (part.bytes) {
          chunks.push(part.bytes);
        } else if (part.file) {
          sawFile = true;
        }
      }

      const { bytes, truncated } = concatArrayBuffers(chunks, this.settings.maxRequestBodyBytes);
      if (sawFile && bytes.byteLength === 0) {
        return this.buildRequestTextPayload(captureId, "[file upload body not captured]", BODY_KIND.MULTIPART, true, 0);
      }

      if (hasBinarySignals(bytes)) {
        return this.buildRequestBinaryPayload(captureId, bytes, truncated);
      }

      const text = decodeText(bytes, "utf-8");
      return this.buildRequestTextPayload(captureId, text, BODY_KIND.UNKNOWN, truncated, bytes.byteLength);
    }

    return null;
  }

  buildRequestBinaryPayload(captureId, bytes, truncated) {
    const storageKey = `payload:${captureId}:request`;
    const preview = `[binary request body sample: ${bytes.byteLength} bytes]`;
    const bodyRef = {
      kind: BODY_KIND.BINARY,
      storageKey,
      byteLength: bytes.byteLength,
      capturedByteLength: bytes.byteLength,
      truncated,
      preview
    };

    return {
      bodyRef,
      payload: {
        id: storageKey,
        captureId,
        role: "request",
        kind: BODY_KIND.BINARY,
        byteLength: bytes.byteLength,
        capturedByteLength: bytes.byteLength,
        truncated,
        bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      }
    };
  }

  buildRequestTextPayload(captureId, text, kind, truncated, byteLength) {
    const storageKey = `payload:${captureId}:request`;
    const encodedLength = new TextEncoder().encode(text).byteLength;
    const capturedByteLength = Math.min(byteLength || encodedLength, this.settings.maxRequestBodyBytes);
    const bodyRef = {
      kind,
      storageKey,
      byteLength: byteLength || encodedLength,
      capturedByteLength,
      truncated,
      charset: "utf-8",
      preview: text.slice(0, this.settings.maxPreviewChars)
    };

    return {
      bodyRef,
      payload: {
        id: storageKey,
        captureId,
        role: "request",
        kind,
        byteLength: bodyRef.byteLength,
        capturedByteLength,
        truncated,
        text
      }
    };
  }

  activeFilteredCount() {
    let count = 0;
    for (const state of this.pending.values()) {
      if (state.filterAttached && !state.responseDone) {
        count += 1;
      }
    }
    return count;
  }

  async handleMessage(rawMessage) {
    let message;
    try {
      message = validateMessage(rawMessage);
    } catch {
      throw new Error("Invalid request.");
    }

    if (message.action === "GET_STATE") {
      return {
        settings: this.settings,
        approvedOrigins: this.permissions.getOrigins(),
        pendingCount: this.pending.size,
        captureCount: await this.store.countCaptures()
      };
    }

    if (message.action === "GET_CAPTURES") {
      return this.store.listCaptures(message.limit || 100);
    }

    if (message.action === "GET_CAPTURE") {
      return this.store.getCapture(message.id);
    }

    if (message.action === "GET_PAYLOAD") {
      return this.store.getPayload(message.storageKey);
    }

    if (message.action === "GET_ENTITIES") {
      return this.store.listEntities(message.captureId);
    }

    if (message.action === "SET_CAPTURE_ENABLED") {
      this.settings = await this.store.updateSettings({
        captureEnabled: message.enabled,
        captureMode: message.enabled ? CAPTURE_MODE.APPROVED_SITES : CAPTURE_MODE.OFF
      });
      return { settings: this.settings };
    }

    if (message.action === "SET_CAPTURE_SCOPE") {
      const patch = this.scopePatchFromMessage(message);
      this.settings = await this.store.updateSettings(patch);
      return { settings: this.settings };
    }

    if (message.action === "UPDATE_SETTINGS") {
      const patch = {};
      for (const key of [
        "captureEnabled",
        "onboardingAcknowledged",
        "parserEnabled",
        "includeCookiesInFullCurl",
        "maxRecords",
        "ttlMs",
        "maxRequestBodyBytes",
        "maxResponseBodyBytes"
      ]) {
        if (Object.prototype.hasOwnProperty.call(message, key) && message[key] !== undefined) {
          patch[key] = message[key];
        }
      }
      this.settings = await this.store.updateSettings(patch);
      if (retentionChanged(patch)) {
        await this.store.enforceRetention(this.settings);
      }
      return { settings: this.settings };
    }

    if (message.action === "PURGE_ALL") {
      await this.store.purgeAll();
      return { ok: true };
    }

    if (message.action === "PURGE_SITE") {
      await this.store.purgeSite(message.host);
      return { ok: true };
    }

    if (message.action === "SYNC_PERMISSIONS") {
      return { approvedOrigins: await this.permissions.refresh() };
    }

    if (message.action === "GENERATE_CURL") {
      return this.generateCurlForMessage(message);
    }

    throw new Error("Unsupported request.");
  }

  scopePatchFromMessage(message) {
    if (message.mode === CAPTURE_MODE.OFF) {
      return {
        captureEnabled: false,
        captureMode: CAPTURE_MODE.OFF,
        scopedTabId: null,
        scopedOriginPattern: null
      };
    }

    if (message.mode === CAPTURE_MODE.CURRENT_TAB) {
      if (!Number.isInteger(message.tabId)) {
        throw new Error("Current-tab capture requires a tab.");
      }
      return {
        captureEnabled: true,
        captureMode: CAPTURE_MODE.CURRENT_TAB,
        scopedTabId: message.tabId,
        scopedOriginPattern: null
      };
    }

    if (message.mode === CAPTURE_MODE.CURRENT_SITE) {
      if (typeof message.originPattern !== "string") {
        throw new Error("Current-site capture requires an origin.");
      }
      return {
        captureEnabled: true,
        captureMode: CAPTURE_MODE.CURRENT_SITE,
        scopedTabId: null,
        scopedOriginPattern: message.originPattern
      };
    }

    return {
      captureEnabled: true,
      captureMode: CAPTURE_MODE.APPROVED_SITES,
      scopedTabId: null,
      scopedOriginPattern: null
    };
  }

  async generateCurlForMessage(message) {
    const capture = await this.store.getCapture(message.id);
    if (!capture) {
      throw new Error("Capture not found.");
    }

    let requestBodyText = "";
    if (capture.request.body?.storageKey && !capture.request.body.truncated) {
      const payload = await this.store.getPayload(capture.request.body.storageKey);
      requestBodyText = typeof payload?.text === "string" ? payload.text : "";
    }

    const result = generateCurl(capture, {
      profile: message.profile,
      revealSecrets: message.revealSecrets,
      includeCookies: this.settings.includeCookiesInFullCurl,
      requestBodyText
    });

    if (message.revealSecrets) {
      await this.store.recordFullCopyAudit(capture.id, message.profile);
    }

    return result;
  }
}

function normalizeHeaderEntries(headers, source) {
  return headers
    .filter((header) => header && typeof header.name === "string")
    .map((header) => ({
      name: header.name,
      value: String(header.value ?? ""),
      redacted: isSensitiveHeaderName(header.name),
      source
    }));
}

function createCaptureId() {
  if (globalThis.crypto?.randomUUID) {
    return `cap:${globalThis.crypto.randomUUID()}`;
  }
  const suffix = Math.random().toString(36).slice(2);
  return `cap:${Date.now().toString(36)}-${suffix}`;
}

function hasApiPathMarker(path) {
  return /(?:^|\/)(?:api|graphql|rest|v[0-9]+|rpc|query|ajax)(?:\/|$)|\.json$/i.test(path);
}

function pathLooksCollectionEndpoint(path) {
  return hasApiPathMarker(path) || /\/(?:users|posts|comments|messages|items|events)(?:\/|$)/i.test(path);
}

function retentionChanged(patch) {
  return Object.prototype.hasOwnProperty.call(patch, "maxRecords") ||
    Object.prototype.hasOwnProperty.call(patch, "ttlMs") ||
    Object.prototype.hasOwnProperty.call(patch, "maxRequestBodyBytes") ||
    Object.prototype.hasOwnProperty.call(patch, "maxResponseBodyBytes");
}

export function metadataOnlyCapture(capture) {
  const next = structuredClone(capture);
  next.classification = {
    ...next.classification,
    labels: Array.from(new Set([...(next.classification?.labels || []), CAPTURE_STATE.METADATA_ONLY]))
  };
  next.replay = {
    ...next.replay,
    warnings: Array.from(new Set([...(next.replay?.warnings || []), "storage_metadata_only"]))
  };
  next.error = {
    source: "storage",
    message: "Payload storage failed; metadata-only capture was retained."
  };

  if (next.request?.body) {
    next.request.body = metadataOnlyBodyRef(next.request.body);
  }

  if (next.response?.body) {
    next.response.body = metadataOnlyBodyRef(next.response.body);
  }

  return next;
}

function metadataOnlyBodyRef(bodyRef) {
  return {
    kind: bodyRef.kind || BODY_KIND.UNKNOWN,
    byteLength: bodyRef.byteLength || 0,
    capturedByteLength: 0,
    truncated: true,
    sha256: bodyRef.sha256,
    charset: bodyRef.charset,
    contentEncoding: bodyRef.contentEncoding,
    preview: "[payload omitted after storage failure]"
  };
}
