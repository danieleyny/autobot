import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  timeout: 30_000,
  use: {
    browserName: "chromium",
    headless: true,
    screenshot: "only-on-failure"
  },
  webServer: {
    command: "npm run mock",
    url: "http://127.0.0.1:4173/api/state",
    reuseExistingServer: true,
    timeout: 30_000
  }
});
