document.querySelector("#open-event").addEventListener("click", async () => {
  await chrome.tabs.create({ url: "https://posh.vip/e/test-release" });
  window.close();
});
