import { DEFAULT_SETTINGS } from "../shared/constants.js";

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
    const maxRecords = settings.maxRecords || DEFAULT_SETTINGS.maxRecords;
    const ttlMs = settings.ttlMs || DEFAULT_SETTINGS.ttlMs;
    const now = Date.now();
    const captures = await this.listCaptures(maxRecords + 5000);
    const deleteIds = [];

    for (let index = 0; index < captures.length; index += 1) {
      const capture = captures[index];
      if (index >= maxRecords || now - capture.startedAt > ttlMs) {
        deleteIds.push(capture.id);
      }
    }

    if (deleteIds.length === 0) {
      return;
    }

    const db = await this.open();
    const tx = db.transaction(["captures", "payloads", "entities"], "readwrite");
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
    await txDone(tx);
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

    if (deleteIds.length === 0) {
      return 0;
    }

    const tx = db.transaction(["captures", "payloads", "entities"], "readwrite");
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
    await txDone(tx);
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
