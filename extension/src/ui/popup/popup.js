import { hostFromUrl, originPatternFromUrl } from "../../shared/match-pattern.js";

const captureMode = document.querySelector("#capture-mode");
const siteHost = document.querySelector("#site-host");
const sitePermission = document.querySelector("#site-permission");
const captureCount = document.querySelector("#capture-count");
const pendingCount = document.querySelector("#pending-count");
const allowSite = document.querySelector("#allow-site");
const openSidebar = document.querySelector("#open-sidebar");
const purgeSite = document.querySelector("#purge-site");
const errorLine = document.querySelector("#error-line");
const onboarding = document.querySelector("#onboarding");
const ackOnboarding = document.querySelector("#ack-onboarding");

let activeTab = null;
let activePattern = null;
let activeHost = null;

function setError(message) {
  errorLine.textContent = message || "";
}

async function send(action, extra = {}) {
  return browser.runtime.sendMessage({ action, ...extra });
}

async function loadActiveTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  activeTab = tabs[0] || null;
  activePattern = null;
  activeHost = null;

  if (!activeTab?.url) {
    siteHost.textContent = "No site";
    sitePermission.textContent = "Permission unavailable";
    allowSite.disabled = true;
    purgeSite.disabled = true;
    return;
  }

  try {
    activePattern = originPatternFromUrl(activeTab.url);
    activeHost = hostFromUrl(activeTab.url);
    siteHost.textContent = activeHost;
    allowSite.disabled = false;
    purgeSite.disabled = false;
  } catch {
    siteHost.textContent = "Unsupported page";
    sitePermission.textContent = "HTTP(S) only";
    allowSite.disabled = true;
    purgeSite.disabled = true;
  }
}

async function refresh() {
  setError("");
  await loadActiveTab();
  const state = await send("GET_STATE");
  captureMode.value = state.settings.captureEnabled === false
    ? "off"
    : state.settings.captureMode || "approved-sites";
  onboarding.hidden = Boolean(state.settings.onboardingAcknowledged);
  captureCount.textContent = String(state.captureCount || 0);
  pendingCount.textContent = String(state.pendingCount || 0);

  if (!activePattern) {
    return;
  }

  const hasPermission = await browser.permissions.contains({ origins: [activePattern] });
  sitePermission.textContent = hasPermission ? "Allowed" : "Not allowed";
  allowSite.disabled = hasPermission;
}

captureMode.addEventListener("change", async () => {
  try {
    const mode = captureMode.value;
    const payload = { mode };
    if (mode === "current-tab") {
      if (!Number.isInteger(activeTab?.id)) {
        setError("Current tab capture needs an active tab.");
        return;
      }
      payload.tabId = activeTab.id;
    } else if (mode === "current-site") {
      if (!activePattern) {
        setError("Current site capture needs an HTTP(S) site.");
        return;
      }
      payload.originPattern = activePattern;
    }
    await send("SET_CAPTURE_SCOPE", payload);
    await refresh();
  } catch {
    setError("Could not update capture scope.");
  }
});

ackOnboarding.addEventListener("click", async () => {
  try {
    await send("UPDATE_SETTINGS", { onboardingAcknowledged: true });
    await refresh();
  } catch {
    setError("Could not save onboarding acknowledgement.");
  }
});

allowSite.addEventListener("click", async () => {
  if (!activePattern) {
    return;
  }

  try {
    const granted = await browser.permissions.request({ origins: [activePattern] });
    if (granted) {
      await send("SYNC_PERMISSIONS");
    }
    await refresh();
  } catch {
    setError("Permission request failed.");
  }
});

openSidebar.addEventListener("click", async () => {
  try {
    await browser.sidebarAction.open();
  } catch {
    setError("Could not open sidebar.");
  }
});

purgeSite.addEventListener("click", async () => {
  if (!activeHost) {
    return;
  }

  const confirmed = confirm(`Purge captures for ${activeHost}?`);
  if (!confirmed) {
    return;
  }

  try {
    await send("PURGE_SITE", { host: activeHost });
    await refresh();
  } catch {
    setError("Purge failed.");
  }
});

void refresh().catch(() => {
  setError("Curlsmith is not ready.");
});
