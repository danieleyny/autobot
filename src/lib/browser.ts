import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type BrowserContext } from "playwright";

const profileDirectory = resolve(".posh-profile");

export async function persistentContext(headed = true): Promise<BrowserContext> {
  await mkdir(profileDirectory, { recursive: true });
  return chromium.launchPersistentContext(profileDirectory, {
    headless: !headed,
    viewport: { width: 1440, height: 960 },
    locale: "en-US",
    timezoneId: "America/New_York"
  });
}
