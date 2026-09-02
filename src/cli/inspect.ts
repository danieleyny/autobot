import { cliOptions, loadConfig } from "../lib/config.js";
import { persistentContext } from "../lib/browser.js";
import { AuditLog } from "../lib/audit.js";
import { assertExpectedEvent } from "../adapters/common.js";
import { unlockPoshEventIfNeeded } from "../adapters/posh.js";

const options = cliOptions();
const config = await loadConfig(options.configPath);
const audit = new AuditLog();
await audit.initialize();
const context = await persistentContext(options.headed);
const page = context.pages()[0] ?? (await context.newPage());

try {
  await page.goto(config.eventUrl, { waitUntil: "domcontentloaded" });
  if (config.provider === "posh") {
    await unlockPoshEventIfNeeded(page, config, audit);
  }
  await assertExpectedEvent(page, config);
  const buttons = await page.getByRole("button").allTextContents();
  const links = await page.getByRole("link").allTextContents();
  await page.screenshot({ path: `${audit.directory}/inspection.png`, fullPage: true });
  await audit.record("inspection-complete", {
    title: await page.title(),
    buttons: buttons.map((value) => value.trim()).filter(Boolean).slice(0, 50),
    links: links.map((value) => value.trim()).filter(Boolean).slice(0, 50)
  });
  console.log(`Inspection artifacts: ${audit.directory}`);
} finally {
  await context.close();
}
