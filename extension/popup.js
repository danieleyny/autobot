document.querySelector("#open-event").addEventListener("click", async () => {
  const stored = await chrome.storage.local.get("autobot:last-event-url");
  const saved = stored["autobot:last-event-url"];
  let url = "https://posh.vip/";
  try {
    const candidate = new URL(saved);
    if (
      candidate.protocol === "https:" &&
      candidate.hostname === "posh.vip" &&
      candidate.pathname.startsWith("/e/")
    ) {
      url = candidate.toString();
    }
  } catch {
    // No Command Center event has been sent to this browser yet.
  }
  await chrome.tabs.create({ url });
  window.close();
});
