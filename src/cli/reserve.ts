import { runMockFlow } from "../adapters/mock.js";
import { runPoshFlow } from "../adapters/posh.js";
import { AuditLog } from "../lib/audit.js";
import { persistentContext } from "../lib/browser.js";
import { assertExecutionAllowed, cliOptions, loadConfig } from "../lib/config.js";
import { waitUntil } from "../lib/wait.js";

const options = cliOptions();
const config = await loadConfig(options.configPath);
assertExecutionAllowed(config, options.execute);

const audit = new AuditLog();
await audit.initialize();
await audit.record("run-started", {
  provider: config.provider,
  execute: options.execute,
  eventUrl: config.eventUrl
});

const context = await persistentContext(options.headed);
const page = context.pages()[0] ?? (await context.newPage());

try {
  await waitUntil(config.releaseAt);
  await audit.record("release-time-reached");
  const outcome =
    config.provider === "mock"
      ? await runMockFlow(page, config, audit, options.execute)
      : await runPoshFlow(page, config, audit, options.execute);
  await page.screenshot({ path: `${audit.directory}/result.png`, fullPage: true });
  console.log(`Outcome: ${outcome}`);
  console.log(`Artifacts: ${audit.directory}`);
} catch (error) {
  await page.screenshot({ path: `${audit.directory}/error.png`, fullPage: true }).catch(() => {});
  await audit.record("run-failed", {
    message: error instanceof Error ? error.message : String(error)
  });
  throw error;
} finally {
  await context.close();
}
