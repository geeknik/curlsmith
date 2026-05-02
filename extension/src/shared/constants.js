export const BODY_KIND = Object.freeze({
  NONE: "none",
  TEXT: "text",
  JSON: "json",
  FORM: "form",
  MULTIPART: "multipart",
  BINARY: "binary",
  UNKNOWN: "unknown"
});

export const CAPTURE_STATE = Object.freeze({
  IGNORED: "ignored",
  METADATA_ONLY: "metadataOnly",
  CAPTURED: "captured",
  TRUNCATED: "truncated",
  BINARY: "binary",
  ERRORED: "errored"
});

export const CAPTURE_MODE = Object.freeze({
  OFF: "off",
  CURRENT_TAB: "current-tab",
  CURRENT_SITE: "current-site",
  APPROVED_SITES: "approved-sites"
});

export const DEFAULT_SETTINGS = Object.freeze({
  captureEnabled: true,
  captureMode: CAPTURE_MODE.APPROVED_SITES,
  scopedTabId: null,
  scopedOriginPattern: null,
  onboardingAcknowledged: false,
  maxRecords: 1000,
  ttlMs: 24 * 60 * 60 * 1000,
  maxTotalPayloadBytes: 100 * 1024 * 1024,
  maxRequestBodyBytes: 512 * 1024,
  maxResponseBodyBytes: 2 * 1024 * 1024,
  maxConcurrentFilteredRequests: 64,
  maxPreviewChars: 4096,
  parserEnabled: true,
  parserMaxDepth: 12,
  parserMaxEntities: 5000,
  includeCookiesInFullCurl: false,
  binaryCaptureEnabled: false
});

export const REDACTED_VALUE = "<REDACTED>";

export const SENSITIVE_HEADER_PATTERN =
  /(?:^authorization$|^cookie$|^set-cookie$|csrf|xsrf|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|session|auth|credential|jwt|bearer|password)/i;

export const SENSITIVE_KEY_PATTERN =
  /(?:^token$|access_token|refresh_token|authenticity_token|csrf|xsrf|session|^sid$|password|passwd|secret|api_key|apikey|credential|jwt|bearer)/i;

export const TOKEN_LIKE_VALUE_PATTERN =
  /(?:^[A-Za-z0-9_-]{20,}$|^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$|^[a-f0-9]{32,}$)/i;

export const OMIT_REPLAY_HEADERS = Object.freeze(new Set([
  "host",
  "content-length",
  "connection",
  "proxy-connection",
  "te",
  "trailer",
  "upgrade",
  "keep-alive",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-user",
  "sec-gpc",
  "upgrade-insecure-requests",
  "priority"
]));

export const BROWSER_GENERATED_HEADER_NAMES = Object.freeze(new Set([
  "accept-encoding",
  "user-agent",
  "dnt"
]));

export const DEFAULT_REPLAY_HEADER_NAMES = Object.freeze(new Set([
  "accept",
  "content-type",
  "authorization",
  "cookie",
  "origin",
  "referer"
]));

export const API_REQUEST_TYPES = Object.freeze(new Set([
  "xmlhttprequest",
  "fetch",
  "beacon"
]));

export const API_PATH_MARKERS = Object.freeze([
  "/api/",
  "/graphql",
  "/rest/",
  "/v1/",
  "/v2/",
  "/rpc",
  "/query",
  "/ajax",
  ".json"
]);

export const JSON_CONTENT_TYPE_PATTERN =
  /(?:^|[/+.-])(?:json|graphql|problem\+json|x-ndjson|ndjson)(?:$|[;\s])/i;

export const TEXT_CONTENT_TYPE_PATTERN =
  /(?:^text\/|xml|html|javascript|x-www-form-urlencoded)/i;
