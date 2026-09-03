const BRIDGE_URL = "http://127.0.0.1:4181";
const BRIDGE_VERSION = "0.11.1";
const LAST_EVENT_KEY = "autobot:last-event-url";
const NAVIGATION_ALARM = "autobot-navigation-poll";
let navigationPolling = false;

async function bridgePost(path, body) {
  const response = await fetch(`${BRIDGE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-autobot-bridge": BRIDGE_VERSION
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2_500)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Local bridge returned HTTP ${response.status}.`);
  return result;
}

function validEventUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "posh.vip" && url.pathname.startsWith("/e/");
  } catch {
    return false;
  }
}

async function openEvent(eventUrl) {
  if (!validEventUrl(eventUrl)) throw new Error("The Command Center sent an invalid POSH event URL.");
  const tabs = await chrome.tabs.query({ url: "https://posh.vip/e/*" });
  const target = tabs.find((tab) => tab.active) || tabs[0];
  if (target?.id) {
    await chrome.tabs.update(target.id, { url: eventUrl, active: true });
    if (typeof target.windowId === "number") {
      await chrome.windows.update(target.windowId, { focused: true });
    }
  } else {
    await chrome.tabs.create({ url: eventUrl, active: true });
  }
  await chrome.storage.local.set({ [LAST_EVENT_KEY]: eventUrl });
}

async function pollNavigation() {
  if (navigationPolling) return;
  navigationPolling = true;
  try {
    const stored = await chrome.storage.local.get("autobot:allow-control");
    const controlEnabled = stored["autobot:allow-control"] !== false;
    const result = await bridgePost("/extension/navigation-poll", { controlEnabled });
    const command = result?.command;
    if (!controlEnabled || command?.type !== "open-event" || !command.id) return;
    try {
      await openEvent(command.payload?.eventUrl);
      await bridgePost("/extension/report", {
        commandId: command.id,
        runId: command.runId,
        phase: "event-opened",
        detail: { eventUrl: command.payload?.eventUrl }
      });
    } catch (error) {
      await bridgePost("/extension/report", {
        commandId: command.id,
        runId: command.runId,
        phase: "failed",
        detail: { message: error instanceof Error ? error.message : String(error) }
      }).catch(() => {});
    }
  } catch {
    // The local bridge may be closed. The next poll retries quietly.
  } finally {
    navigationPolling = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender.url?.startsWith("https://posh.vip/e/")) return false;
  if (message?.type === "autobot:control-poll") {
    bridgePost("/extension/poll", { status: message.status })
      .then(sendResponse)
      .catch(() => sendResponse({ connected: false }));
    return true;
  }
  if (message?.type === "autobot:control-report") {
    bridgePost("/extension/report", message.report)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(NAVIGATION_ALARM, { periodInMinutes: 0.5 });
  pollNavigation();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(NAVIGATION_ALARM, { periodInMinutes: 0.5 });
  pollNavigation();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === NAVIGATION_ALARM) pollNavigation();
});

chrome.alarms.create(NAVIGATION_ALARM, { periodInMinutes: 0.5 });
setInterval(pollNavigation, 2_000);
pollNavigation();
