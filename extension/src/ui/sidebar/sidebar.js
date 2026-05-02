import { BODY_KIND } from "../../shared/constants.js";
import { entitiesToCsv, entitiesToJsonl } from "../../shared/entity-export.js";
import { jsonTreeRowsFromText } from "../../shared/json-tree.js";
import { redactHeader, redactJsonValue, isSensitiveKey, isTokenLike } from "../../shared/redactor.js";

const requestList = document.querySelector("#request-list");
const filterText = document.querySelector("#filter-text");
const methodFilter = document.querySelector("#method-filter");
const statusFilter = document.querySelector("#status-filter");
const bodyFilter = document.querySelector("#body-filter");
const entityFilter = document.querySelector("#entity-filter");
const refreshButton = document.querySelector("#refresh");
const purgeAllButton = document.querySelector("#purge-all");
const emptyState = document.querySelector("#empty-state");
const captureDetail = document.querySelector("#capture-detail");
const summaryMethod = document.querySelector("#summary-method");
const summaryUrl = document.querySelector("#summary-url");
const summaryStatus = document.querySelector("#summary-status");
const tabHeaders = document.querySelector("#tab-headers");
const tabBody = document.querySelector("#tab-body");
const tabEntities = document.querySelector("#tab-entities");
const profileSelect = document.querySelector("#profile-select");
const copyRedacted = document.querySelector("#copy-redacted");
const copyFull = document.querySelector("#copy-full");
const curlOutput = document.querySelector("#curl-output");
const curlWarnings = document.querySelector("#curl-warnings");
const statusLine = document.querySelector("#status-line");

let captures = [];
let selectedCapture = null;
let selectedPayloads = new Map();
let selectedEntities = [];
let capturesWithEntities = new Set();

function setStatus(message) {
  statusLine.textContent = message || "";
}

async function send(action, extra = {}) {
  return browser.runtime.sendMessage({ action, ...extra });
}

function clearNode(node) {
  while (node.firstChild) {
    node.firstChild.remove();
  }
}

function appendText(parent, tag, text, className) {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  element.textContent = text ?? "";
  parent.append(element);
  return element;
}

function captureMatchesFilter(capture) {
  const filter = filterText.value.trim().toLowerCase();
  if (filter) {
    const haystack = [
      capture.request?.method,
      capture.request?.host,
      capture.request?.path,
      capture.request?.url,
      capture.response?.statusCode,
      capture.response?.contentType,
      capture.type,
      capture.classification?.labels?.join(" ")
    ].join(" ").toLowerCase();
    if (!haystack.includes(filter)) {
      return false;
    }
  }

  if (methodFilter.value && capture.request?.method !== methodFilter.value) {
    return false;
  }

  if (!statusMatches(capture, statusFilter.value)) {
    return false;
  }

  if (!bodyMatches(capture, bodyFilter.value)) {
    return false;
  }

  if (!entityMatches(capture, entityFilter.value)) {
    return false;
  }

  return true;
}

function renderList() {
  clearNode(requestList);
  const filtered = captures.filter((item) => captureMatchesFilter(item));

  for (const capture of filtered) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "request-row";
    if (selectedCapture?.id === capture.id) {
      row.classList.add("is-active");
    }

    appendText(row, "span", capture.request.method, "method");
    appendText(row, "span", statusText(capture), "status");

    const urlBox = document.createElement("span");
    urlBox.className = "request-url";
    appendText(urlBox, "div", capture.request.host, "request-host");
    appendText(urlBox, "div", capture.request.path || "/", "request-path");
    row.append(urlBox);

    row.addEventListener("click", () => {
      void selectCapture(capture.id);
    });
    requestList.append(row);
  }

  setStatus(`${filtered.length} of ${captures.length} captures shown`);
}

async function refreshCaptures() {
  captures = await send("GET_CAPTURES", { limit: 250 });
  const entities = await send("GET_ENTITIES");
  capturesWithEntities = new Set(entities.map((entity) => entity.sourceCaptureId));
  renderList();
}

function statusMatches(capture, filter) {
  if (!filter) {
    return true;
  }
  if (filter === "error") {
    return Boolean(capture.error);
  }
  const status = Number(capture.response?.statusCode);
  if (!Number.isInteger(status)) {
    return false;
  }
  const lowerBound = Number(filter[0]) * 100;
  return status >= lowerBound && status < lowerBound + 100;
}

function bodyMatches(capture, filter) {
  if (!filter) {
    return true;
  }
  const requestBody = capture.request?.body;
  const responseBody = capture.response?.body;
  if (filter === "request") {
    return Boolean(requestBody && requestBody.kind !== BODY_KIND.NONE);
  }
  if (filter === "response") {
    return Boolean(responseBody && responseBody.kind !== BODY_KIND.NONE);
  }
  if (filter === "truncated") {
    return Boolean(requestBody?.truncated || responseBody?.truncated);
  }
  if (filter === "binary") {
    return requestBody?.kind === BODY_KIND.BINARY || responseBody?.kind === BODY_KIND.BINARY;
  }
  return true;
}

function entityMatches(capture, filter) {
  if (!filter) {
    return true;
  }
  const hasEntities = capturesWithEntities.has(capture.id);
  return filter === "has-entities" ? hasEntities : !hasEntities;
}

async function selectCapture(id) {
  selectedCapture = await send("GET_CAPTURE", { id });
  selectedPayloads = new Map();
  selectedEntities = [];
  if (!selectedCapture) {
    return;
  }

  for (const body of [selectedCapture.request.body, selectedCapture.response?.body]) {
    if (body?.storageKey) {
      const payload = await send("GET_PAYLOAD", { storageKey: body.storageKey });
      if (payload) {
        selectedPayloads.set(body.storageKey, payload);
      }
    }
  }

  emptyState.hidden = true;
  captureDetail.hidden = false;
  summaryMethod.textContent = selectedCapture.request.method;
  summaryUrl.textContent = selectedCapture.request.url;
  summaryStatus.textContent = selectedCapture.response?.statusCode
    ? String(selectedCapture.response.statusCode)
    : statusText(selectedCapture);

  renderHeaders();
  renderBodies();
  await renderCurl(false);
  await renderEntities();
  renderList();
}

function statusText(capture) {
  if (capture.error) {
    return "ERR";
  }
  return capture.response?.statusCode || "-";
}

function renderHeaders() {
  clearNode(tabHeaders);
  renderHeaderTable(tabHeaders, "Request headers", selectedCapture.request.headers || []);
  renderHeaderTable(tabHeaders, "Response headers", selectedCapture.response?.headers || []);
}

function renderHeaderTable(parent, title, headers) {
  const section = document.createElement("section");
  appendText(section, "h2", title, "section-title");
  const table = document.createElement("table");
  table.className = "kv-table";
  const tbody = document.createElement("tbody");

  for (const header of headers) {
    const safeHeader = redactHeader(header, false);
    const row = document.createElement("tr");
    appendText(row, "th", safeHeader.name);
    appendText(row, "td", safeHeader.value);
    tbody.append(row);
  }

  table.append(tbody);
  section.append(table);
  parent.append(section);
}

function renderBodies() {
  clearNode(tabBody);
  renderBodyBlock(tabBody, "Request body", selectedCapture.request.body);
  renderBodyBlock(tabBody, "Response body", selectedCapture.response?.body);
}

function renderBodyBlock(parent, title, bodyRef) {
  const section = document.createElement("section");
  appendText(section, "h2", title, "section-title");

  if (!bodyRef || bodyRef.kind === BODY_KIND.NONE) {
    const pre = document.createElement("pre");
    pre.className = "code-block";
    pre.textContent = "No body captured";
    section.append(pre);
  } else if (bodyRef.truncated) {
    const pre = document.createElement("pre");
    pre.className = "code-block";
    pre.textContent = `${bodyRef.kind} body truncated at ${bodyRef.capturedByteLength} bytes`;
    section.append(pre);
  } else if (bodyRef.storageKey) {
    const payload = selectedPayloads.get(bodyRef.storageKey);
    renderPayloadViews(section, payload);
  } else {
    const pre = document.createElement("pre");
    pre.className = "code-block";
    pre.textContent = bodyRef.preview || "";
    section.append(pre);
  }

  parent.append(section);
}

function renderPayloadViews(parent, payload) {
  const text = redactedPayloadText(payload);
  const views = document.createElement("div");
  views.className = "body-views";

  if (isJsonPayload(payload, text)) {
    try {
      views.append(renderJsonTree(text));
    } catch {
      // Fall back to raw text below.
    }
  }

  const details = document.createElement("details");
  details.className = "raw-details";
  if (!isJsonPayload(payload, text)) {
    details.open = true;
  }
  const summary = document.createElement("summary");
  summary.textContent = "Raw preview";
  const pre = document.createElement("pre");
  pre.className = "code-block";
  pre.textContent = text;
  details.append(summary, pre);
  views.append(details);
  parent.append(views);
}

function renderJsonTree(text) {
  const tree = document.createElement("div");
  tree.className = "json-tree";

  for (const row of jsonTreeRowsFromText(text, { maxDepth: 10, maxNodes: 1500 })) {
    const element = document.createElement("div");
    element.className = `json-row json-kind-${row.kind}`;
    element.style.paddingLeft = `${Math.min(row.depth, 12) * 12}px`;
    appendText(element, "span", row.key, "json-key");
    appendText(element, "span", row.preview, "json-value");
    tree.append(element);
  }

  return tree;
}

function isJsonPayload(payload, text) {
  if (!payload || payload.kind === BODY_KIND.BINARY) {
    return false;
  }
  return payload.kind === BODY_KIND.JSON || text.trimStart().startsWith("{") || text.trimStart().startsWith("[");
}

function redactedPayloadText(payload) {
  if (!payload) {
    return "";
  }

  if (payload.kind === BODY_KIND.BINARY) {
    return `[binary body sample: ${payload.capturedByteLength} bytes]`;
  }

  const text = String(payload.text || "");
  if (payload.kind === BODY_KIND.JSON || text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) {
    try {
      return JSON.stringify(redactJsonValue(JSON.parse(text)), null, 2);
    } catch {
      return redactTokenLikeText(text);
    }
  }

  if (payload.kind === BODY_KIND.FORM) {
    const params = new URLSearchParams(text);
    const redacted = new URLSearchParams();
    for (const [key, value] of params.entries()) {
      redacted.append(key, isSensitiveKey(key, value) ? "<REDACTED>" : value);
    }
    return redacted.toString();
  }

  return redactTokenLikeText(text);
}

function redactTokenLikeText(text) {
  return text
    .split(/(\s+)/)
    .map((part) => isTokenLike(part) ? "<REDACTED>" : part)
    .join("");
}

async function renderCurl(revealSecrets) {
  if (!selectedCapture) {
    return;
  }

  const result = await send("GENERATE_CURL", {
    id: selectedCapture.id,
    profile: profileSelect.value,
    revealSecrets
  });
  curlOutput.textContent = result.command;

  clearNode(curlWarnings);
  for (const warning of result.warnings || []) {
    appendText(curlWarnings, "li", warning);
  }
}

async function renderEntities() {
  clearNode(tabEntities);
  selectedEntities = await send("GET_ENTITIES", { captureId: selectedCapture.id });
  const toolbar = document.createElement("div");
  toolbar.className = "entity-toolbar";
  const exportJsonl = document.createElement("button");
  exportJsonl.type = "button";
  exportJsonl.textContent = "Export JSONL";
  const exportCsv = document.createElement("button");
  exportCsv.type = "button";
  exportCsv.textContent = "Export CSV";
  exportJsonl.disabled = selectedEntities.length === 0;
  exportCsv.disabled = selectedEntities.length === 0;
  exportJsonl.addEventListener("click", () => exportEntities("jsonl"));
  exportCsv.addEventListener("click", () => exportEntities("csv"));
  toolbar.append(exportJsonl, exportCsv);
  tabEntities.append(toolbar);

  const table = document.createElement("table");
  table.className = "kv-table";
  const tbody = document.createElement("tbody");

  for (const entity of selectedEntities) {
    const row = document.createElement("tr");
    appendText(row, "th", entity.type);
    appendText(row, "td", entitySummary(entity));
    tbody.append(row);
  }

  if (selectedEntities.length === 0) {
    appendText(tabEntities, "p", "No entities extracted");
    return;
  }

  table.append(tbody);
  tabEntities.append(table);
}

function entitySummary(entity) {
  const label = entity.title || entity.text || entity.displayName || entity.externalId || entity.rawPath;
  const provenance = entity.rawPath ? ` (${entity.rawPath})` : "";
  return `${label}${provenance}`;
}

function exportEntities(format) {
  if (!selectedCapture || selectedEntities.length === 0) {
    return;
  }

  const confirmed = confirm("Export normalized extracted entities to a local file? Captured raw objects are not included.");
  if (!confirmed) {
    return;
  }

  const host = selectedCapture.request.host.replace(/[^a-z0-9.-]+/gi, "_");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `curlsmith-entities-${host}-${timestamp}.${format}`;
  const text = format === "csv" ? entitiesToCsv(selectedEntities) : entitiesToJsonl(selectedEntities);
  const type = format === "csv" ? "text/csv" : "application/x-ndjson";
  downloadText(filename, text, type);
  setStatus(`Exported ${selectedEntities.length} entities`);
}

function downloadText(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyCurrentCurl(revealSecrets) {
  if (!selectedCapture) {
    return;
  }

  if (revealSecrets) {
    const confirmed = confirm("Copy full-fidelity cURL with captured secrets?");
    if (!confirmed) {
      return;
    }
  }

  await renderCurl(revealSecrets);
  await navigator.clipboard.writeText(curlOutput.textContent);
  setStatus(revealSecrets ? "Full command copied" : "Redacted command copied");
}

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("is-active"));
    button.classList.add("is-active");
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.hidden = panel.id !== `tab-${button.dataset.tab}`;
    });
  });
});

filterText.addEventListener("input", renderList);
methodFilter.addEventListener("change", renderList);
statusFilter.addEventListener("change", renderList);
bodyFilter.addEventListener("change", renderList);
entityFilter.addEventListener("change", renderList);
refreshButton.addEventListener("click", () => void refreshCaptures());
profileSelect.addEventListener("change", () => void renderCurl(false));
copyRedacted.addEventListener("click", () => void copyCurrentCurl(false).catch(() => setStatus("Copy failed")));
copyFull.addEventListener("click", () => void copyCurrentCurl(true).catch(() => setStatus("Copy failed")));
purgeAllButton.addEventListener("click", async () => {
  if (!confirm("Purge all captures?")) {
    return;
  }
  await send("PURGE_ALL");
  selectedCapture = null;
  selectedPayloads = new Map();
  selectedEntities = [];
  captureDetail.hidden = true;
  emptyState.hidden = false;
  await refreshCaptures();
});

browser.runtime.onMessage.addListener((message) => {
  if (message?.action === "CAPTURES_UPDATED") {
    void refreshCaptures();
  }
});

void refreshCaptures().catch(() => {
  setStatus("Could not load captures");
});
