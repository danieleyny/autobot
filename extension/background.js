const BRIDGE_URL = "http://127.0.0.1:4181";
const BRIDGE_VERSION = "0.8.0";

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
