import { randomBytes, randomUUID } from "node:crypto";
import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateDeviceKeyPair } from "./encryption.js";
import { launchWorkerBrowser } from "./profile-browser.js";
import {
  autobotSupportDirectory,
  profileHostConfigPath,
  type ProfileHostConfig,
  type ProfileWorkerConfig,
} from "./profile-host-options.js";
import { normalizeControllerUrl, readOption } from "./options.js";

const VERSION = "0.13.0";
const DEFAULT_BRIDGE_PORT = 4182;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceExtensionDirectory = path.join(projectRoot, "extension");
const targetConfigPath = profileHostConfigPath();
const supportDirectory = readOption("host-root")
  ? path.resolve(readOption("host-root")!)
  : autobotSupportDirectory();

function workerCount(value: string | undefined, fallback: number): number {
  const parsed = Math.trunc(Number(value ?? fallback));
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 4) {
    throw new Error("Profile host setup supports between one and four workers.");
  }
  return parsed;
}

async function readExistingConfig(): Promise<ProfileHostConfig | null> {
  try {
    return JSON.parse(await readFile(targetConfigPath, "utf8")) as ProfileHostConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function saveConfig(config: ProfileHostConfig) {
  await mkdir(path.dirname(targetConfigPath), { recursive: true });
  await writeFile(targetConfigPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(targetConfigPath, 0o600).catch(() => {});
}

async function pairWorker(
  controllerUrl: string,
  code: string,
  hostName: string,
  workerIndex: number,
): Promise<ProfileWorkerConfig> {
  const keyPair = generateDeviceKeyPair();
  const requestedName = `${hostName} · Profile ${workerIndex}`;
  const response = await fetch(`${controllerUrl}/api/device`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "pair",
      code,
      name: requestedName,
      version: VERSION,
      publicKey: keyPair.publicKeyPem,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = (await response.json()) as {
    error?: string;
    deviceId?: string;
    token?: string;
    name?: string;
  };
  if (!response.ok || !result.deviceId || !result.token) {
    throw new Error(result.error || `Pairing profile ${workerIndex} failed with HTTP ${response.status}.`);
  }
  const workerKey = `worker-${String(workerIndex).padStart(2, "0")}`;
  return {
    controllerUrl,
    deviceId: result.deviceId,
    token: result.token,
    name: result.name || requestedName,
    publicKeyPem: keyPair.publicKeyPem,
    privateKeyPem: keyPair.privateKeyPem,
    workerId: `${workerKey}-${randomUUID().slice(0, 8)}`,
    workerIndex,
    bridgeToken: randomBytes(24).toString("base64url"),
    profileDirectory: path.join(supportDirectory, "profile-host", "chrome", workerKey),
    extensionDirectory: path.join(supportDirectory, "profile-host", "extensions", workerKey),
  };
}

async function prepareWorkerExtension(config: ProfileHostConfig, worker: ProfileWorkerConfig) {
  await mkdir(path.dirname(worker.extensionDirectory), { recursive: true });
  await cp(sourceExtensionDirectory, worker.extensionDirectory, { recursive: true, force: true });
  const profileConfig = {
    workerId: worker.workerId,
    workerIndex: worker.workerIndex,
    workerName: worker.name,
    hostId: config.hostId,
    hostName: config.hostName,
    bridgePort: config.bridgePort,
    bridgeToken: worker.bridgeToken,
  };
  await writeFile(
    path.join(worker.extensionDirectory, "worker-config.js"),
    `globalThis.AUTOBOT_PROFILE_WORKER = Object.freeze(${JSON.stringify(profileConfig, null, 2)});\n`,
    "utf8",
  );
  await mkdir(worker.profileDirectory, { recursive: true });
}

let config = await readExistingConfig();
const suppliedCode = readOption("code")?.trim().toUpperCase() ?? "";
const requestedWorkerCount = readOption("workers");
if (!config) {
  const controllerUrl = normalizeControllerUrl(
    readOption("controller", "https://autobot-command-center.avgschnook.chatgpt.site")!,
  );
  const hostName = readOption("name")?.trim().slice(0, 60) ?? "";
  const desiredWorkerCount = workerCount(requestedWorkerCount, 4);
  if (!suppliedCode) throw new Error("An enrollment code is required for a new profile host.");
  if (!hostName) throw new Error("A computer name is required for a new profile host.");
  config = {
    version: VERSION,
    hostId: randomUUID(),
    hostName,
    controllerUrl,
    bridgePort: DEFAULT_BRIDGE_PORT,
    desiredWorkerCount,
    workers: [],
  };
  await saveConfig(config);
}

config.version = VERSION;
config.bridgePort = DEFAULT_BRIDGE_PORT;
if (requestedWorkerCount) {
  const desiredWorkerCount = workerCount(requestedWorkerCount, config.desiredWorkerCount);
  if (desiredWorkerCount < config.workers.length) {
    throw new Error("Reducing a configured profile host is not automatic. Remove unwanted workers in the Command Center instead.");
  }
  config.desiredWorkerCount = desiredWorkerCount;
}

const replacementIndex = Math.trunc(Number(readOption("replace-worker", "0")));
if (replacementIndex) {
  if (!suppliedCode) throw new Error("Replacing a worker requires a new enrollment code.");
  const existingWorker = config.workers[replacementIndex - 1];
  if (!existingWorker || replacementIndex < 1 || replacementIndex > 4) {
    throw new Error("The worker selected for replacement is not configured on this host.");
  }
  const replacement = await pairWorker(config.controllerUrl, suppliedCode, config.hostName, replacementIndex);
  replacement.profileDirectory = existingWorker.profileDirectory;
  replacement.extensionDirectory = existingWorker.extensionDirectory;
  config.workers[replacementIndex - 1] = replacement;
  await saveConfig(config);
  console.log(`Replaced Profile ${replacementIndex}; approve its new worker in the Command Center.`);
}

if (config.workers.length < config.desiredWorkerCount && !suppliedCode) {
  throw new Error(
    `This host has ${config.workers.length}/${config.desiredWorkerCount} workers. Supply a valid enrollment code to finish setup.`,
  );
}

for (let workerIndex = config.workers.length + 1; workerIndex <= config.desiredWorkerCount; workerIndex += 1) {
  const worker = await pairWorker(config.controllerUrl, suppliedCode, config.hostName, workerIndex);
  config.workers.push(worker);
  await saveConfig(config);
  console.log(`Paired ${worker.name}; approve it in the Command Center.`);
}

for (const worker of config.workers) await prepareWorkerExtension(config, worker);
await saveConfig(config);

console.log(`Profile host ready: ${config.hostName} with ${config.workers.length} worker profiles.`);
console.log(`Saved host configuration: ${targetConfigPath}`);
for (const worker of config.workers) {
  console.log(`Profile ${worker.workerIndex} extension: ${worker.extensionDirectory}`);
}

if (!process.argv.includes("--no-onboarding")) {
  for (const worker of config.workers) {
    await launchWorkerBrowser(worker, "chrome://extensions/");
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  console.log("Chrome profile windows opened. Load the matching numbered extension in each window and sign into POSH once.");
}
