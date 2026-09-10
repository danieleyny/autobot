import { chmod, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import express, { type Request } from "express";
import { decryptForDevice, generateDeviceKeyPair } from "./encryption.js";
import { launchWorkerBrowser } from "./profile-browser.js";
import {
  profileHostConfigPath,
  type ProfileHostConfig,
  type ProfileWorkerConfig,
} from "./profile-host-options.js";
import { readOption } from "./options.js";

type ControllerCommand = {
  id: string;
  runId: string | null;
  type: string;
  payload: Record<string, unknown>;
};

type WorkerRuntime = {
  worker: ProfileWorkerConfig;
  extensionStatus: Record<string, unknown>;
  extensionSeenAt: number;
  backgroundSeenAt: number;
  backgroundControlEnabled: boolean;
  pendingCommand: ControllerCommand | null;
  controllerOnline: boolean;
  approvalPending: boolean;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
  heartbeatDueAt: number;
  heartbeatInFlight: boolean;
  clockOffsetMs: number;
  clockRoundTripMs: number | null;
  clockSamples: Array<{ offsetMs: number; roundTripMs: number }>;
  browserLaunchPromise: Promise<void> | null;
  lastBrowserLaunchAt: number;
};

const VERSION = "0.13.0";
const BRIDGE_PROTOCOL_VERSION = "0.12.2";
const ACTIVE_POLL_INTERVAL_MS = 1_000;
const IDLE_POLL_INTERVAL_MS = 15_000;
const CLOCK_SAMPLE_LIMIT = 8;
const configFile = profileHostConfigPath();
const config = JSON.parse(await readFile(configFile, "utf8")) as ProfileHostConfig;
const port = Number(readOption("port", String(config.bridgePort || 4182)));
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("Profile host bridge port is invalid.");
}
if (!Array.isArray(config.workers) || config.workers.length < 1 || config.workers.length > 4) {
  throw new Error("Profile host configuration must contain between one and four workers.");
}

for (const worker of config.workers) {
  if (!worker.publicKeyPem || !worker.privateKeyPem) {
    const keyPair = generateDeviceKeyPair();
    worker.publicKeyPem = keyPair.publicKeyPem;
    worker.privateKeyPem = keyPair.privateKeyPem;
  }
}
await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
await chmod(configFile, 0o600).catch(() => {});

const runtimes = new Map<string, WorkerRuntime>(
  config.workers.map((worker) => [
    worker.workerId,
    {
      worker,
      extensionStatus: {},
      extensionSeenAt: 0,
      backgroundSeenAt: 0,
      backgroundControlEnabled: true,
      pendingCommand: null,
      controllerOnline: false,
      approvalPending: false,
      heartbeatTimer: null,
      heartbeatDueAt: Number.POSITIVE_INFINITY,
      heartbeatInFlight: false,
      clockOffsetMs: 0,
      clockRoundTripMs: null,
      clockSamples: [],
      browserLaunchPromise: null,
      lastBrowserLaunchAt: 0,
    },
  ]),
);
let stopping = false;

function pageConnectedNow(runtime: WorkerRuntime) {
  return Date.now() - runtime.extensionSeenAt < 4_000;
}

function extensionConnectedNow(runtime: WorkerRuntime) {
  return pageConnectedNow(runtime) || Date.now() - runtime.backgroundSeenAt < 4_000;
}

function desiredPollIntervalMs(runtime: WorkerRuntime) {
  return pageConnectedNow(runtime) || runtime.pendingCommand
    ? ACTIVE_POLL_INTERVAL_MS
    : IDLE_POLL_INTERVAL_MS;
}

function hostResources() {
  return {
    totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
    freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
    cpuCount: os.cpus().length,
    loadAverage1m: Number((os.loadavg()[0] ?? 0).toFixed(2)),
  };
}

function updateClockEstimate(
  runtime: WorkerRuntime,
  serverTime: unknown,
  startedAt: number,
  finishedAt: number,
) {
  const serverTimestamp = Number(serverTime);
  if (!Number.isFinite(serverTimestamp)) return;
  const roundTripMs = Math.max(0, finishedAt - startedAt);
  if (roundTripMs > 5_000) return;
  const observedOffsetMs = serverTimestamp - (startedAt + finishedAt) / 2;
  if (runtime.clockSamples.length && Math.abs(observedOffsetMs - runtime.clockOffsetMs) > 1_000) {
    runtime.clockSamples.length = 0;
  }
  runtime.clockSamples.push({ offsetMs: observedOffsetMs, roundTripMs });
  if (runtime.clockSamples.length > CLOCK_SAMPLE_LIMIT) runtime.clockSamples.shift();
  const best = [...runtime.clockSamples].sort((left, right) => left.roundTripMs - right.roundTripMs)[0];
  if (!best) return;
  runtime.clockOffsetMs = Math.round(best.offsetMs);
  runtime.clockRoundTripMs = Math.round(best.roundTripMs);
}

async function controllerRequest(runtime: WorkerRuntime, body: Record<string, unknown>) {
  const response = await fetch(`${runtime.worker.controllerUrl}/api/device`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${runtime.worker.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  const result = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(result.error || `Controller returned HTTP ${response.status}.`));
  return result;
}

async function reportCommand(
  runtime: WorkerRuntime,
  command: ControllerCommand,
  phase: string,
  detail: Record<string, unknown> = {},
) {
  return controllerRequest(runtime, {
    action: "report",
    commandId: command.id,
    runId: command.runId,
    phase,
    detail,
  });
}

async function ensureWorkerBrowser(runtime: WorkerRuntime, targetUrl: string, force = false) {
  if (!force && extensionConnectedNow(runtime)) return;
  if (runtime.browserLaunchPromise) return runtime.browserLaunchPromise;
  // A repeated dashboard click must not create duplicate windows while Chrome
  // is still starting and before the extension has sent its first heartbeat.
  if (Date.now() - runtime.lastBrowserLaunchAt < 10_000) return;
  runtime.browserLaunchPromise = (async () => {
    const delayMs = Math.max(0, (runtime.worker.workerIndex - 1) * 900);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await launchWorkerBrowser(runtime.worker, targetUrl);
    runtime.lastBrowserLaunchAt = Date.now();
  })().finally(() => {
    runtime.browserLaunchPromise = null;
  });
  return runtime.browserLaunchPromise;
}

async function acceptCommand(runtime: WorkerRuntime, command: ControllerCommand) {
  const payload = { ...command.payload };
  if (typeof payload.eventSecret === "string") {
    payload.eventPassword = decryptForDevice(payload.eventSecret, runtime.worker.privateKeyPem!);
    delete payload.eventSecret;
  }
  const decryptedCommand = { ...command, payload };

  if (decryptedCommand.type === "launch-worker") {
    const startUrl =
      typeof decryptedCommand.payload.startUrl === "string"
        ? decryptedCommand.payload.startUrl
        : "https://posh.vip/";
    const alreadyRunning = extensionConnectedNow(runtime);
    await ensureWorkerBrowser(runtime, startUrl, !alreadyRunning);
    await reportCommand(runtime, decryptedCommand, "worker-launched", { alreadyRunning });
    console.log(`${runtime.worker.name}: ${alreadyRunning ? "already running" : "browser launched"}.`);
    return;
  }

  runtime.pendingCommand = decryptedCommand;
  console.log(`${runtime.worker.name}: received ${decryptedCommand.type} command ${decryptedCommand.id}.`);
  if (decryptedCommand.type === "open-event" && !extensionConnectedNow(runtime)) {
    const eventUrl =
      typeof decryptedCommand.payload.eventUrl === "string"
        ? decryptedCommand.payload.eventUrl
        : "https://posh.vip/";
    void ensureWorkerBrowser(runtime, eventUrl).catch((error) => {
      console.error(`${runtime.worker.name}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

async function heartbeat(runtime: WorkerRuntime) {
  const requestStartedAt = Date.now();
  try {
    const pageConnected = pageConnectedNow(runtime);
    const extensionConnected = extensionConnectedNow(runtime);
    const pageStatus = pageConnected ? runtime.extensionStatus : {};
    const pollIntervalMs = desiredPollIntervalMs(runtime);
    const result = await controllerRequest(runtime, {
      action: "poll",
      version: VERSION,
      publicKey: runtime.worker.publicKeyPem,
      status: {
        ...pageStatus,
        bridgeOnline: true,
        extensionConnected,
        controlConnected:
          extensionConnected &&
          runtime.backgroundControlEnabled !== false &&
          pageStatus.controlEnabled !== false,
        pageReady: pageConnected && pageStatus.pageReady === true,
        bridgePort: port,
        pollIntervalMs,
        profileMode: "multi",
        hostId: config.hostId,
        hostName: config.hostName,
        workerId: runtime.worker.workerId,
        workerIndex: runtime.worker.workerIndex,
        workerCount: config.workers.length,
        hostResources: hostResources(),
      },
    });
    updateClockEstimate(runtime, result.serverTime, requestStartedAt, Date.now());
    runtime.controllerOnline = true;
    const wasApprovalPending = runtime.approvalPending;
    runtime.approvalPending = result.approvalPending === true;
    if (runtime.approvalPending && !wasApprovalPending) {
      console.log(`${runtime.worker.name}: waiting for Command Center approval.`);
    }
    if (!runtime.approvalPending && wasApprovalPending) {
      console.log(`${runtime.worker.name}: approved for fleet control.`);
    }
    if (!runtime.pendingCommand && result.command && typeof result.command === "object") {
      try {
        await acceptCommand(runtime, result.command as ControllerCommand);
      } catch (error) {
        const command = result.command as ControllerCommand;
        console.error(`${runtime.worker.name}: ${error instanceof Error ? error.message : String(error)}`);
        await reportCommand(runtime, command, "failed", {
          message: "The profile host could not process this command.",
        }).catch(() => {});
      }
    }
  } catch (error) {
    if (runtime.controllerOnline) {
      console.error(`${runtime.worker.name}: controller connection lost: ${error instanceof Error ? error.message : String(error)}`);
    }
    runtime.controllerOnline = false;
  }
}

function scheduleHeartbeat(runtime: WorkerRuntime, delayMs = desiredPollIntervalMs(runtime)) {
  if (stopping) return;
  const dueAt = Date.now() + Math.max(0, delayMs);
  if (runtime.heartbeatTimer && runtime.heartbeatDueAt <= dueAt) return;
  if (runtime.heartbeatTimer) clearTimeout(runtime.heartbeatTimer);
  runtime.heartbeatDueAt = dueAt;
  runtime.heartbeatTimer = setTimeout(() => {
    runtime.heartbeatTimer = null;
    runtime.heartbeatDueAt = Number.POSITIVE_INFINITY;
    void runHeartbeat(runtime);
  }, Math.max(0, delayMs));
}

async function runHeartbeat(runtime: WorkerRuntime) {
  if (runtime.heartbeatInFlight || stopping) return;
  runtime.heartbeatInFlight = true;
  try {
    await heartbeat(runtime);
  } finally {
    runtime.heartbeatInFlight = false;
    scheduleHeartbeat(runtime);
  }
}

function runtimeForRequest(request: Request): WorkerRuntime | null {
  const workerId = request.get("x-autobot-worker") ?? "";
  const bridgeToken = request.get("x-autobot-worker-token") ?? "";
  const runtime = runtimes.get(workerId);
  return runtime && bridgeToken === runtime.worker.bridgeToken ? runtime : null;
}

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use((request, response, next) => {
  const origin = request.get("origin");
  if (origin && !origin.startsWith("chrome-extension://")) {
    response.status(403).json({ error: "The profile host accepts requests only from its Chrome workers." });
    return;
  }
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader(
    "Access-Control-Allow-Headers",
    "content-type,x-autobot-bridge,x-autobot-worker,x-autobot-worker-token",
  );
  if (request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }
  if (
    request.path.startsWith("/extension/") &&
    request.get("x-autobot-bridge") !== BRIDGE_PROTOCOL_VERSION
  ) {
    response.status(401).json({ error: "Extension bridge protocol is missing." });
    return;
  }
  if (request.path.startsWith("/extension/") && !runtimeForRequest(request)) {
    response.status(401).json({ error: "This Chrome profile is not registered with the profile host." });
    return;
  }
  next();
});

app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    version: VERSION,
    hostId: config.hostId,
    hostName: config.hostName,
    port,
    resources: hostResources(),
    workers: [...runtimes.values()].map((runtime) => ({
      id: runtime.worker.workerId,
      name: runtime.worker.name,
      controllerOnline: runtime.controllerOnline,
      approvalPending: runtime.approvalPending,
      extensionConnected: extensionConnectedNow(runtime),
      pageConnected: pageConnectedNow(runtime),
      pendingCommand: runtime.pendingCommand?.type ?? null,
      pollIntervalMs: desiredPollIntervalMs(runtime),
    })),
  });
});

app.post("/extension/poll", (request, response) => {
  const runtime = runtimeForRequest(request)!;
  const wasPageConnected = pageConnectedNow(runtime);
  runtime.extensionSeenAt = Date.now();
  runtime.extensionStatus =
    request.body?.status && typeof request.body.status === "object" ? request.body.status : {};
  if (!wasPageConnected) scheduleHeartbeat(runtime, 0);
  response.json({
    connected: runtime.controllerOnline,
    approvalPending: runtime.approvalPending,
    deviceName: runtime.worker.name,
    hostName: config.hostName,
    clockOffsetMs: runtime.clockOffsetMs,
    clockRoundTripMs: runtime.clockRoundTripMs,
    command:
      runtime.extensionStatus.controlEnabled === false || runtime.pendingCommand?.type === "open-event"
        ? null
        : runtime.pendingCommand,
  });
});

app.post("/extension/navigation-poll", (request, response) => {
  const runtime = runtimeForRequest(request)!;
  runtime.backgroundSeenAt = Date.now();
  runtime.backgroundControlEnabled = request.body?.controlEnabled !== false;
  scheduleHeartbeat(runtime, 0);
  response.json({
    connected: runtime.controllerOnline,
    approvalPending: runtime.approvalPending,
    deviceName: runtime.worker.name,
    hostName: config.hostName,
    clockOffsetMs: runtime.clockOffsetMs,
    clockRoundTripMs: runtime.clockRoundTripMs,
    command:
      runtime.backgroundControlEnabled && runtime.pendingCommand?.type === "open-event"
        ? runtime.pendingCommand
        : null,
  });
});

app.post("/extension/report", async (request, response) => {
  const runtime = runtimeForRequest(request)!;
  try {
    const commandId = typeof request.body?.commandId === "string" ? request.body.commandId : "";
    const result = await controllerRequest(runtime, {
      action: "report",
      commandId,
      runId: request.body?.runId,
      phase: request.body?.phase,
      detail: request.body?.detail,
    });
    if (
      runtime.pendingCommand?.id === commandId &&
      [
        "accepted",
        "prepared",
        "standby",
        "stopped",
        "failed",
        "inspection-complete",
        "submitted",
        "submitted-unconfirmed",
        "confirmed",
        "already-reserved",
        "event-opened",
        "reset-complete",
        "local-override",
      ].includes(String(request.body?.phase))
    ) {
      runtime.pendingCommand = null;
    }
    response.json(result);
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const server = app.listen(port, "127.0.0.1", () => {
  console.log(`AUTOBOT profile host v${VERSION}: ${config.hostName}`);
  console.log(`Local profile bridge: http://127.0.0.1:${port}`);
  console.log(`${config.workers.length} isolated Chrome workers configured.`);
});

await Promise.all([...runtimes.values()].map((runtime) => runHeartbeat(runtime)));

function shutdown() {
  stopping = true;
  for (const runtime of runtimes.values()) {
    if (runtime.heartbeatTimer) clearTimeout(runtime.heartbeatTimer);
  }
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
