const captureEnabled = document.querySelector("#capture-enabled");
const parserEnabled = document.querySelector("#parser-enabled");
const purgeAll = document.querySelector("#purge-all");
const retentionForm = document.querySelector("#retention-form");
const approvedOrigins = document.querySelector("#approved-origins");
const captureMode = document.querySelector("#capture-mode");
const scopedOrigin = document.querySelector("#scoped-origin");
const maxRecords = document.querySelector("#max-records");
const ttl = document.querySelector("#ttl");
const totalPayloadCap = document.querySelector("#total-payload-cap");
const requestCap = document.querySelector("#request-cap");
const responseCap = document.querySelector("#response-cap");
const maxRecordsInput = document.querySelector("#max-records-input");
const ttlHoursInput = document.querySelector("#ttl-hours-input");
const totalPayloadCapInput = document.querySelector("#total-payload-cap-input");
const requestCapInput = document.querySelector("#request-cap-input");
const responseCapInput = document.querySelector("#response-cap-input");
const statusLine = document.querySelector("#status-line");

function setStatus(message) {
  statusLine.textContent = message || "";
}

async function send(action, extra = {}) {
  return browser.runtime.sendMessage({ action, ...extra });
}

function bytes(value) {
  if (value >= 1024 * 1024) {
    return `${Math.round(value / 1024 / 1024)} MiB`;
  }
  return `${Math.round(value / 1024)} KiB`;
}

function clearNode(node) {
  while (node.firstChild) {
    node.firstChild.remove();
  }
}

async function refresh() {
  const state = await send("GET_STATE");
  captureEnabled.checked = Boolean(state.settings.captureEnabled);
  parserEnabled.checked = Boolean(state.settings.parserEnabled);
  captureMode.textContent = state.settings.captureEnabled === false
    ? "off"
    : state.settings.captureMode || "approved-sites";
  scopedOrigin.textContent = state.settings.scopedOriginPattern || "-";
  maxRecords.textContent = String(state.settings.maxRecords);
  ttl.textContent = `${Math.round(state.settings.ttlMs / 60 / 60 / 1000)} h`;
  totalPayloadCap.textContent = bytes(state.settings.maxTotalPayloadBytes);
  requestCap.textContent = bytes(state.settings.maxRequestBodyBytes);
  responseCap.textContent = bytes(state.settings.maxResponseBodyBytes);
  maxRecordsInput.value = String(state.settings.maxRecords);
  ttlHoursInput.value = String(Math.round(state.settings.ttlMs / 60 / 60 / 1000));
  totalPayloadCapInput.value = String(Math.round(state.settings.maxTotalPayloadBytes / 1024 / 1024));
  requestCapInput.value = String(Math.round(state.settings.maxRequestBodyBytes / 1024));
  responseCapInput.value = String(Math.round(state.settings.maxResponseBodyBytes / 1024));

  clearNode(approvedOrigins);
  if (state.approvedOrigins.length === 0) {
    const item = document.createElement("li");
    item.textContent = "No origins approved";
    approvedOrigins.append(item);
  } else {
    for (const origin of state.approvedOrigins) {
      const item = document.createElement("li");
      item.textContent = origin;
      approvedOrigins.append(item);
    }
  }
}

captureEnabled.addEventListener("change", async () => {
  await send("SET_CAPTURE_ENABLED", { enabled: captureEnabled.checked });
  setStatus("Saved");
});

parserEnabled.addEventListener("change", async () => {
  await send("UPDATE_SETTINGS", { parserEnabled: parserEnabled.checked });
  setStatus("Saved");
});

retentionForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const maxRecordsValue = boundedInteger(maxRecordsInput.value, 10, 5000);
  const ttlHours = boundedInteger(ttlHoursInput.value, 1, 720);
  const totalPayloadMiB = boundedInteger(totalPayloadCapInput.value, 0, 1024);
  const requestKiB = boundedInteger(requestCapInput.value, 0, 1024);
  const responseKiB = boundedInteger(responseCapInput.value, 0, 5120);

  if ([maxRecordsValue, ttlHours, totalPayloadMiB, requestKiB, responseKiB].some((value) => value === null)) {
    setStatus("Retention values are out of range.");
    return;
  }

  await send("UPDATE_SETTINGS", {
    maxRecords: maxRecordsValue,
    ttlMs: ttlHours * 60 * 60 * 1000,
    maxTotalPayloadBytes: totalPayloadMiB * 1024 * 1024,
    maxRequestBodyBytes: requestKiB * 1024,
    maxResponseBodyBytes: responseKiB * 1024
  });
  setStatus("Retention saved");
  await refresh();
});

purgeAll.addEventListener("click", async () => {
  if (!confirm("Purge all captures?")) {
    return;
  }
  await send("PURGE_ALL");
  setStatus("Purged");
  await refresh();
});

void refresh().catch(() => {
  setStatus("Could not load options");
});

function boundedInteger(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return null;
  }
  return parsed;
}
