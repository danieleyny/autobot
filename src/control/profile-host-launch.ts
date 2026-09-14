import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchWorkerBrowser } from "./profile-browser.js";
import { profileHostConfigPath, type ProfileHostConfig } from "./profile-host-options.js";

const BUILD_ID = "v0.13.2-beta.1";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const agentScript = path.join(projectRoot, "src", "control", "profile-host-agent.ts");
const configFile = profileHostConfigPath();
const config = JSON.parse(await readFile(configFile, "utf8")) as ProfileHostConfig;
const healthUrl = `http://127.0.0.1:${config.bridgePort || 4182}/health`;

type HealthState = {
  buildId?: string;
  workers?: Array<{ id?: string; extensionConnected?: boolean }>;
};

async function readHealth(): Promise<HealthState | null> {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) });
    return response.ok ? await response.json() as HealthState : null;
  } catch {
    return null;
  }
}

let health = await readHealth();
if (!health) {
  const child = spawn(
    process.execPath,
    [tsxCli, agentScript, `--host-config=${configFile}`],
    { cwd: projectRoot, detached: true, stdio: "ignore" },
  );
  child.unref();
  const deadline = Date.now() + 15_000;
  while (!health && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    health = await readHealth();
  }
}

if (!health) throw new Error("The local profile host did not start within 15 seconds.");
if (health.buildId !== BUILD_ID) {
  throw new Error(`A different profile host build is already running (${health.buildId || "unknown"}). Restart the computer to load ${BUILD_ID}.`);
}

const connectedIds = new Set(
  (health.workers || []).filter((worker) => worker.extensionConnected).map((worker) => worker.id),
);
const workersToLaunch = config.workers.filter((worker) => !connectedIds.has(worker.workerId));
for (const worker of workersToLaunch) {
  await launchWorkerBrowser(worker, "https://posh.vip/");
  await new Promise((resolve) => setTimeout(resolve, 500));
}

console.log(`AUTOBOT ${BUILD_ID} is running for ${config.hostName}.`);
console.log(
  workersToLaunch.length
    ? `Opened ${workersToLaunch.length} missing Chrome profile${workersToLaunch.length === 1 ? "" : "s"}.`
    : "All configured Chrome profiles were already running.",
);
console.log(`Command Center: ${config.controllerUrl}`);
console.log(`Local performance report: ${path.join(path.dirname(configFile), "profile-host-performance.json")}`);
