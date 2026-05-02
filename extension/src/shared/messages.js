const ACTION_SCHEMAS = Object.freeze({
  GET_STATE: Object.freeze({}),
  GET_CAPTURES: Object.freeze({ limit: "optionalPositiveInteger" }),
  GET_CAPTURE: Object.freeze({ id: "captureId" }),
  GET_PAYLOAD: Object.freeze({ storageKey: "storageKey" }),
  GET_ENTITIES: Object.freeze({ captureId: "optionalCaptureId" }),
  SET_CAPTURE_ENABLED: Object.freeze({ enabled: "boolean" }),
  SET_CAPTURE_SCOPE: Object.freeze({
    mode: "captureMode",
    tabId: "optionalTabId",
    originPattern: "optionalOriginPattern"
  }),
  UPDATE_SETTINGS: Object.freeze({
    captureEnabled: "optionalBoolean",
    onboardingAcknowledged: "optionalBoolean",
    parserEnabled: "optionalBoolean",
    includeCookiesInFullCurl: "optionalBoolean",
    maxRecords: "optionalRetentionRecords",
    ttlMs: "optionalTtlMs",
    maxTotalPayloadBytes: "optionalTotalPayloadByteLimit",
    maxRequestBodyBytes: "optionalRequestByteLimit",
    maxResponseBodyBytes: "optionalResponseByteLimit"
  }),
  PURGE_ALL: Object.freeze({}),
  PURGE_SITE: Object.freeze({ host: "host" }),
  SYNC_PERMISSIONS: Object.freeze({}),
  GENERATE_CURL: Object.freeze({
    id: "captureId",
    profile: "curlProfile",
    revealSecrets: "boolean"
  })
});

const VALID_CURL_PROFILES = new Set([
  "pretty-redacted",
  "pretty-full",
  "compact-redacted",
  "compact-full",
  "heredoc-json"
]);

const VALID_CAPTURE_MODES = new Set([
  "off",
  "current-tab",
  "current-site",
  "approved-sites"
]);

function isPlainObject(value) {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validateCaptureId(value) {
  return typeof value === "string" && /^[a-z0-9:_-]{1,160}$/i.test(value);
}

function validateStorageKey(value) {
  return typeof value === "string" && /^[a-z0-9:_/-]{1,220}$/i.test(value);
}

function validateHost(value) {
  return typeof value === "string" && value.length <= 253 && /^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(value);
}

function validateField(kind, value) {
  if (kind === "boolean") {
    return typeof value === "boolean";
  }
  if (kind === "optionalBoolean") {
    return value === undefined || typeof value === "boolean";
  }
  if (kind === "captureId" || kind === "optionalCaptureId") {
    return value === undefined && kind.startsWith("optional") ? true : validateCaptureId(value);
  }
  if (kind === "storageKey") {
    return validateStorageKey(value);
  }
  if (kind === "host") {
    return validateHost(value);
  }
  if (kind === "curlProfile") {
    return typeof value === "string" && VALID_CURL_PROFILES.has(value);
  }
  if (kind === "captureMode") {
    return typeof value === "string" && VALID_CAPTURE_MODES.has(value);
  }
  if (kind === "optionalTabId") {
    return value === undefined || (Number.isInteger(value) && value >= 0 && value <= 2147483647);
  }
  if (kind === "optionalOriginPattern") {
    return value === undefined ||
      (typeof value === "string" && /^https?:\/\/[^/*\s]+\/\*$/.test(value) && value.length <= 300);
  }
  if (kind === "optionalPositiveInteger") {
    return value === undefined || (Number.isInteger(value) && value > 0 && value <= 1000);
  }
  if (kind === "optionalRetentionRecords") {
    return value === undefined || (Number.isInteger(value) && value >= 10 && value <= 5000);
  }
  if (kind === "optionalTtlMs") {
    return value === undefined || (Number.isInteger(value) && value >= 60 * 60 * 1000 && value <= 30 * 24 * 60 * 60 * 1000);
  }
  if (kind === "optionalTotalPayloadByteLimit") {
    return value === undefined || (Number.isInteger(value) && value >= 0 && value <= 1024 * 1024 * 1024);
  }
  if (kind === "optionalRequestByteLimit") {
    return value === undefined || (Number.isInteger(value) && value >= 0 && value <= 1024 * 1024);
  }
  if (kind === "optionalResponseByteLimit") {
    return value === undefined || (Number.isInteger(value) && value >= 0 && value <= 5 * 1024 * 1024);
  }
  return false;
}

export function validateMessage(message) {
  if (!isPlainObject(message) || typeof message.action !== "string") {
    throw new Error("Invalid message.");
  }

  const schema = ACTION_SCHEMAS[message.action];
  if (!schema) {
    throw new Error("Unknown message action.");
  }

  const allowedKeys = new Set(["action", ...Object.keys(schema)]);
  for (const key of Object.keys(message)) {
    if (!allowedKeys.has(key)) {
      throw new Error("Unexpected message field.");
    }
  }

  for (const [field, kind] of Object.entries(schema)) {
    if (!validateField(kind, message[field])) {
      throw new Error("Invalid message field.");
    }
  }

  return Object.freeze({ ...message });
}
