import { CAPTURE_STATE, DEFAULT_SETTINGS } from "../shared/constants.js";

const DB_NAME = "curlsmith";
const DB_VERSION = 1;
const SETTINGS_KEY = "curlsmith.settings";
const AUDIT_KEY = "curlsmith.auditCopies";

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
  });
}

function txDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted."));
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed."));
  });
}

export class CaptureStore {
  constructor() {
    this.dbPromise = null;
  }

  async open() {
    if (this.dbPromise) {
      return this.dbPromise;
    }

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains("captures")) {
          const captures = db.createObjectStore("captures", { keyPath: "id" });
          captures.createIndex("startedAt", "startedAt");
          captures.createIndex("host", "request.host");
          captures.createIndex("method", "request.method");
          captures.createIndex("apiScore", "classification.apiScore");
        }

        if (!db.objectStoreNames.contains("payloads")) {
          const payloads = db.createObjectStore("payloads", { keyPath: "id" });
          payloads.createIndex("captureId", "captureId");
        }

        if (!db.objectStoreNames.contains("entities")) {
          const entities = db.createObjectStore("entities", { keyPath: "id" });
          entities.createIndex("sourceCaptureId", "sourceCaptureId");
          entities.createIndex("type", "type");
          entities.createIndex("sourceHost", "sourceHost");
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB open failed."));
    });

    return this.dbPromise;
  }

  async getSettings() {
    const stored = await browser.storage.local.get(SETTINGS_KEY);
    const settings = stored[SETTINGS_KEY] || {};
    return { ...DEFAULT_SETTINGS, ...settings };
  }

  async updateSettings(patch) {
    const next = { ...(await this.getSettings()), ...patch };
    await browser.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  }

  async putCapture(capture, payloads = [], entities = []) {
    const db = await this.open();
    const tx = db.transaction(["captures", "payloads", "entities"], "readwrite");
    const captureStore = tx.objectStore("captures");
    const payloadStore = tx.objectStore("payloads");
    const entityStore = tx.objectStore("entities");

    captureStore.put(capture);
    for (const payload of payloads) {
      payloadStore.put(payload);
    }
    for (const entity of entities) {
      entityStore.put(entity);
    }

    await txDone(tx);
  }

  async listCaptures(limit = 100) {
    const db = await this.open();
    const tx = db.transaction("captures", "readonly");
    const index = tx.objectStore("captures").index("startedAt");
    const captures = [];

    await new Promise((resolve, reject) => {
      const request = index.openCursor(null, "prev");
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || captures.length >= limit) {
          resolve();
          return;
        }
        captures.push(cursor.value);
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error("Capture list failed."));
    });

    return captures;
  }

  async countCaptures() {
    const db = await this.open();
    const tx = db.transaction("captures", "readonly");
    return requestToPromise(tx.objectStore("captures").count());
  }

  async getCapture(id) {
    const db = await this.open();
    const tx = db.transaction("captures", "readonly");
    return requestToPromise(tx.objectStore("captures").get(id));
  }

  async getPayload(id) {
    const db = await this.open();
    const tx = db.transaction("payloads", "readonly");
    return requestToPromise(tx.objectStore("payloads").get(id));
  }

  async listEntities(captureId) {
    const db = await this.open();
    const tx = db.transaction("entities", "readonly");
    const store = tx.objectStore("entities");
    if (!captureId) {
      return requestToPromise(store.getAll());
    }
    return requestToPromise(store.index("sourceCaptureId").getAll(captureId));
  }

  async purgeAll() {
    const db = await this.open();
    const tx = db.transaction(["captures", "payloads", "entities"], "readwrite");
    tx.objectStore("captures").clear();
    tx.objectStore("payloads").clear();
    tx.objectStore("entities").clear();
    await txDone(tx);
  }

  async purgeSite(host) {
    const db = await this.open();
    const readTx = db.transaction("captures", "readonly");
    const captures = await requestToPromise(readTx.objectStore("captures").index("host").getAll(host));
    const ids = captures.map((capture) => capture.id);
    if (ids.length === 0) {
      return;
    }

    const tx = db.transaction(["captures", "payloads", "entities"], "readwrite");
    const captureStore = tx.objectStore("captures");
    const payloadIndex = tx.objectStore("payloads").index("captureId");
    const entityIndex = tx.objectStore("entities").index("sourceCaptureId");
    const deletes = [];

    for (const id of ids) {
      captureStore.delete(id);
      deletes.push(deleteByIndex(payloadIndex, id));
      deletes.push(deleteByIndex(entityIndex, id));
    }

    await Promise.all(deletes);
    await txDone(tx);
  }

  async enforceRetention(settings) {
    const effectiveSettings = { ...DEFAULT_SETTINGS, ...settings };
    const maxRecords = boundedInteger(effectiveSettings.maxRecords, DEFAULT_SETTINGS.maxRecords, 10, 5000);
    const captures = await this.listCaptures(maxRecords + 5000);
    const deleteIds = selectCaptureIdsForRetention(captures, Date.now(), effectiveSettings);

    await this.deleteCapturesByIds(deleteIds);
    await this.enforcePayloadBytes(effectiveSettings.maxTotalPayloadBytes);
  }

  async enforcePayloadBytes(maxTotalPayloadBytes) {
    const limit = normalizePayloadLimit(maxTotalPayloadBytes);
    const snapshot = await this.readPayloadRetentionSnapshot();
    const plan = planPayloadRetention(snapshot.captures, snapshot.payloads, limit);
    if (plan.evictions.length === 0) {
      return;
    }

    await this.stripPayloadsForCaptures(plan.evictions);
  }

  async readPayloadRetentionSnapshot() {
    const db = await this.open();
    const tx = db.transaction(["captures", "payloads"], "readonly");
    const done = txDone(tx);
    const captures = [];
    const payloads = [];

    await Promise.all([
      readCursor(tx.objectStore("captures"), (capture) => {
        captures.push({
          id: String(capture.id || ""),
          startedAt: Number.isFinite(capture.startedAt) ? capture.startedAt : 0
        });
      }),
      readCursor(tx.objectStore("payloads"), (payload) => {
        payloads.push({
          id: String(payload.id || ""),
          captureId: String(payload.captureId || ""),
          role: String(payload.role || ""),
          storedSize: payloadStoredSize(payload)
        });
      })
    ]);
    await done;

    return { captures, payloads };
  }

  async stripPayloadsForCaptures(evictions) {
    const byCapture = new Map();
    const payloadIds = new Set();

    for (const eviction of evictions) {
      if (!eviction.payloadId || !eviction.captureId) {
        continue;
      }
      payloadIds.add(eviction.payloadId);
      const capturePayloads = byCapture.get(eviction.captureId) || new Set();
      capturePayloads.add(eviction.payloadId);
      byCapture.set(eviction.captureId, capturePayloads);
    }

    if (payloadIds.size === 0) {
      return;
    }

    const db = await this.open();
    const tx = db.transaction(["captures", "payloads"], "readwrite");
    const done = txDone(tx);
    const captureStore = tx.objectStore("captures");
    const payloadStore = tx.objectStore("payloads");
    const updates = [];

    for (const id of payloadIds) {
      payloadStore.delete(id);
    }

    for (const [captureId, capturePayloadIds] of byCapture.entries()) {
      updates.push(new Promise((resolve, reject) => {
        const request = captureStore.get(captureId);
        request.onsuccess = () => {
          try {
            const capture = request.result;
            if (capture) {
              captureStore.put(stripEvictedPayloadRefs(capture, capturePayloadIds));
            }
            resolve();
          } catch (error) {
            reject(error);
          }
        };
        request.onerror = () => reject(request.error || new Error("Capture payload eviction update failed."));
      }));
    }

    await Promise.all(updates);
    await done;
  }

  async evictOldestCaptures(count = 100) {
    const deleteCount = Number.isInteger(count) && count > 0 ? count : 100;
    const db = await this.open();
    const readTx = db.transaction("captures", "readonly");
    const index = readTx.objectStore("captures").index("startedAt");
    const deleteIds = [];

    await new Promise((resolve, reject) => {
      const request = index.openCursor(null, "next");
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || deleteIds.length >= deleteCount) {
          resolve();
          return;
        }
        deleteIds.push(cursor.value.id);
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error("Oldest capture scan failed."));
    });

    return this.deleteCapturesByIds(deleteIds);
  }

  async deleteCapturesByIds(ids) {
    const deleteIds = Array.from(new Set(ids)).filter((id) => typeof id === "string" && id.length > 0);
    if (deleteIds.length === 0) {
      return 0;
    }
    const db = await this.open();
    const tx = db.transaction(["captures", "payloads", "entities"], "readwrite");
    const done = txDone(tx);
    const captureStore = tx.objectStore("captures");
    const payloadIndex = tx.objectStore("payloads").index("captureId");
    const entityIndex = tx.objectStore("entities").index("sourceCaptureId");
    const deletes = [];

    for (const id of deleteIds) {
      captureStore.delete(id);
      deletes.push(deleteByIndex(payloadIndex, id));
      deletes.push(deleteByIndex(entityIndex, id));
    }

    await Promise.all(deletes);
    await done;
    return deleteIds.length;
  }

  async recordFullCopyAudit(captureId, profile) {
    const stored = await browser.storage.local.get(AUDIT_KEY);
    const events = Array.isArray(stored[AUDIT_KEY]) ? stored[AUDIT_KEY] : [];
    events.unshift({
      at: Date.now(),
      captureId,
      profile
    });
    await browser.storage.local.set({ [AUDIT_KEY]: events.slice(0, 100) });
  }
}

async function deleteByIndex(index, key) {
  await new Promise((resolve, reject) => {
    const request = index.openCursor(IDBKeyRange.only(key));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error("IndexedDB indexed delete failed."));
  });
}

function readCursor(storeOrIndex, onValue) {
  return new Promise((resolve, reject) => {
    const request = storeOrIndex.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      try {
        onValue(cursor.value);
        cursor.continue();
      } catch (error) {
        reject(error);
      }
    };
    request.onerror = () => reject(request.error || new Error("IndexedDB cursor read failed."));
  });
}

export function selectCaptureIdsForRetention(captures, now, settings = {}) {
  const maxRecords = boundedInteger(settings.maxRecords, DEFAULT_SETTINGS.maxRecords, 10, 5000);
  const ttlMs = boundedInteger(settings.ttlMs, DEFAULT_SETTINGS.ttlMs, 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000);
  const ordered = Array.isArray(captures)
    ? captures.slice().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    : [];
  const deleteIds = [];

  for (let index = 0; index < ordered.length; index += 1) {
    const capture = ordered[index];
    if (!capture?.id) {
      continue;
    }
    if (index >= maxRecords || now - (capture.startedAt || 0) > ttlMs) {
      deleteIds.push(capture.id);
    }
  }

  return deleteIds;
}

export function planPayloadRetention(captures, payloads, maxTotalPayloadBytes) {
  const limit = normalizePayloadLimit(maxTotalPayloadBytes);
  const captureStartedAt = new Map();
  for (const capture of Array.isArray(captures) ? captures : []) {
    if (capture?.id) {
      captureStartedAt.set(capture.id, Number.isFinite(capture.startedAt) ? capture.startedAt : 0);
    }
  }

  let totalBytes = 0;
  const candidates = [];
  for (const payload of Array.isArray(payloads) ? payloads : []) {
    const bytes = payloadStoredSize(payload);
    totalBytes += bytes;
    if (!payload?.id || !payload.captureId || bytes <= 0) {
      continue;
    }
    candidates.push({
      payloadId: payload.id,
      captureId: payload.captureId,
      role: payload.role || "",
      bytes,
      startedAt: captureStartedAt.get(payload.captureId) || 0
    });
  }

  let overflowBytes = totalBytes - limit;
  const evictions = [];
  if (overflowBytes <= 0) {
    return { totalBytes, evictedBytes: 0, evictions };
  }

  candidates.sort((a, b) => {
    const age = a.startedAt - b.startedAt;
    if (age !== 0) {
      return age;
    }
    if (a.role === b.role) {
      return a.payloadId.localeCompare(b.payloadId);
    }
    return a.role === "response" ? -1 : 1;
  });

  let evictedBytes = 0;
  for (const candidate of candidates) {
    evictions.push(candidate);
    evictedBytes += candidate.bytes;
    overflowBytes -= candidate.bytes;
    if (overflowBytes <= 0) {
      break;
    }
  }

  return { totalBytes, evictedBytes, evictions };
}

export function payloadStoredSize(payload) {
  for (const key of ["storedSize", "capturedByteLength", "byteLength"]) {
    if (Number.isFinite(payload?.[key]) && payload[key] >= 0) {
      return Math.floor(payload[key]);
    }
  }

  if (payload?.bytes instanceof ArrayBuffer) {
    return payload.bytes.byteLength;
  }

  if (ArrayBuffer.isView(payload?.bytes)) {
    return payload.bytes.byteLength;
  }

  if (typeof payload?.text === "string") {
    return new TextEncoder().encode(payload.text).byteLength;
  }

  return 0;
}

export function stripEvictedPayloadRefs(capture, payloadIds) {
  const ids = payloadIds instanceof Set ? payloadIds : new Set(payloadIds);
  const next = structuredClone(capture);
  let stripped = false;

  if (ids.has(next.request?.body?.storageKey)) {
    next.request.body = evictedBodyRef(next.request.body);
    stripped = true;
  }

  if (ids.has(next.response?.body?.storageKey)) {
    next.response.body = evictedBodyRef(next.response.body);
    stripped = true;
  }

  if (stripped) {
    next.replay = {
      ...next.replay,
      warnings: Array.from(new Set([...(next.replay?.warnings || []), "payload_retention_omitted"]))
    };
    next.classification = {
      ...next.classification,
      labels: Array.from(new Set([...(next.classification?.labels || []), CAPTURE_STATE.METADATA_ONLY]))
    };
  }

  return next;
}

function evictedBodyRef(bodyRef) {
  return {
    kind: bodyRef.kind || "unknown",
    byteLength: bodyRef.byteLength || 0,
    capturedByteLength: 0,
    truncated: true,
    sha256: bodyRef.sha256,
    charset: bodyRef.charset,
    contentEncoding: bodyRef.contentEncoding,
    preview: "[payload evicted by retention policy]"
  };
}

function normalizePayloadLimit(value) {
  return boundedInteger(value, DEFAULT_SETTINGS.maxTotalPayloadBytes, 0, 1024 * 1024 * 1024);
}

function boundedInteger(value, fallback, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
