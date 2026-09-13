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
  browserExpected: boolean;
  lastBrowserRecoveryAt: number;
  browserRecoveryState: "not-requested" | "watching" | "waiting" | "recovering" | "cooldown" | "frozen-near-release";
  lastTargetUrl: string;
  activeRunId: string | null;
  activeRunReleaseAt: number | null;
  lastExtensionPollAt: number;
  extensionPollIntervals: number[];
};

type HostCalibration = {
  measuredAt: number;
  durationMs: number;
  configuredWorkers: number;
  connectedWorkers: number;
  eventReadyWorkers: number;
  recommendedWorkerCount: number;
  averageExtensionGapMs: number | null;
  maxExtensionGapMs: number | null;
  freeMemoryMb: number;
  stable: boolean;
  summary: string;
};

const VERSION = "0.13.1";
const BUILD_ID = "v0.13.1-beta.1";
const BRIDGE_PROTOCOL_VERSION = "0.12.2";
const ACTIVE_POLL_INTERVAL_MS = 1_000;
const IDLE_POLL_INTERVAL_MS = 15_000;
const CLOCK_SAMPLE_LIMIT = 8;
const CALIBRATION_DURATION_MS = 4_000;
const BROWSER_WATCHDOG_INTERVAL_MS = 10_000;
const BROWSER_MISSING_GRACE_MS = 30_000;
const BROWSER_RECOVERY_COOLDOWN_MS = 60_000;
const BROWSER_RECOVERY_FREEZE_MS = 5 * 60_000;
const RUN_RECOVERY_TAIL_MS = 2 * 60_000;
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
      browserExpected: false,
      lastBrowserRecoveryAt: 0,
      browserRecoveryState: "not-requested",
      lastTargetUrl: "https://posh.vip/",
      activeRunId: null,
      activeRunReleaseAt: null,
      lastExtensionPollAt: 0,
      extensionPollIntervals: [],
    },
  ]),
);
let stopping = false;
let hostCalibration: HostCalibration | null = null;
let cachedHostResources: ReturnType<typeof hostResources> | null = null;
let hostResourcesSampledAt = 0;

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

function reportedHostResources() {
  const timestamp = Date.now();
  if (!cachedHostResources || timestamp - hostResourcesSampledAt >= 30_000) {
    cachedHostResources = hostResources();
    hostResourcesSampledAt = timestamp;
  }
  return cachedHostResources;
}

function recordExtensionPoll(runtime: WorkerRuntime, timestamp: number) {
  if (runtime.lastExtensionPollAt > 0) {
    const interval = timestamp - runtime.lastExtensionPollAt;
    if (interval > 0 && interval < 10_000) {
      runtime.extensionPollIntervals.push(interval);
      if (runtime.extensionPollIntervals.length > 40) runtime.extensionPollIntervals.shift();
    }
  }
  runtime.lastExtensionPollAt = timestamp;
}

function recommendedWorkerCount(resources: ReturnType<typeof hostResources>, maxGapMs: number | null) {
  let recommendation = 4;
  if (resources.totalMemoryMb < 8_000 || resources.cpuCount < 4) recommendation = 2;
  else if (resources.totalMemoryMb < 12_000 || resources.cpuCount < 8) recommendation = 3;
  if (resources.freeMemoryMb < 1_500) recommendation = Math.min(recommendation, 2);
  else if (resources.freeMemoryMb < 2_500) recommendation = Math.min(recommendation, 3);
  if (maxGapMs !== null && maxGapMs > 2_000) recommendation = Math.max(1, recommendation - 1);
  return Math.min(config.workers.length, recommendation);
}

async function calibrateHost(): Promise<HostCalibration> {
  for (const runtime of runtimes.values()) runtime.extensionPollIntervals.length = 0;
  await new Promise((resolve) => setTimeout(resolve, CALIBRATION_DURATION_MS));

  const resources = hostResources();
  cachedHostResources = resources;
  hostResourcesSampledAt = Date.now();
  const connected = [...runtimes.values()].filter(extensionConnectedNow);
  const eventReadyWorkers = [...runtimes.values()].filter(
    (runtime) => pageConnectedNow(runtime) && runtime.extensionStatus.pageReady === true,
  ).length;
  const intervals = connected.flatMap((runtime) => runtime.extensionPollIntervals);
  const averageExtensionGapMs = intervals.length
    ? Math.round(intervals.reduce((total, interval) => total + interval, 0) / intervals.length)
    : null;
  const maxExtensionGapMs = intervals.length ? Math.max(...intervals) : null;
  const recommendation = recommendedWorkerCount(resources, maxExtensionGapMs);
  const stable =
    connected.length === config.workers.length &&
    eventReadyWorkers === config.workers.length &&
    resources.freeMemoryMb >= 1_000 &&
    maxExtensionGapMs !== null &&
    maxExtensionGapMs <= 2_000;
  const summary = stable
    ? `${connected.length} workers responded steadily; use up to ${recommendation} on this host.`
    : connected.length !== config.workers.length || eventReadyWorkers !== config.workers.length
      ? `Open the event in every worker, then calibrate again. ${connected.length}/${config.workers.length} browsers and ${eventReadyWorkers}/${config.workers.length} event pages responded.`
      : `Host pressure or browser delay was detected; use no more than ${recommendation} worker${recommendation === 1 ? "" : "s"}.`;

  hostCalibration = {
    measuredAt: Date.now(),
    durationMs: CALIBRATION_DURATION_MS,
    configuredWorkers: config.workers.length,
    connectedWorkers: connected.length,
    eventReadyWorkers,
    recommendedWorkerCount: recommendation,
    averageExtensionGapMs,
    maxExtensionGapMs,
    freeMemoryMb: resources.freeMemoryMb,
    stable,
    summary,
  };
  for (const runtime of runtimes.values()) scheduleHeartbeat(runtime, 0);
  return hostCalibration;
}

function recoveryFrozen(runtime: WorkerRuntime, timestamp: number) {
  if (!runtime.activeRunReleaseAt) return false;
  const untilRelease = runtime.activeRunReleaseAt - timestamp;
  return untilRelease <= BROWSER_RECOVERY_FREEZE_MS && untilRelease >= -RUN_RECOVERY_TAIL_MS;
}

async function runBrowserWatchdog() {
  if (stopping) return;
  const timestamp = Date.now();
  await Promise.all([...runtimes.values()].map(async (runtime) => {
    if (!runtime.browserExpected) {
      runtime.browserRecoveryState = "not-requested";
      return;
    }
    if (extensionConnectedNow(runtime)) {
      runtime.browserRecoveryState = "watching";
      return;
    }
    const lastSeenAt = Math.max(runtime.extensionSeenAt, runtime.backgroundSeenAt);
    if (!lastSeenAt || timestamp - lastSeenAt < BROWSER_MISSING_GRACE_MS) {
      runtime.browserRecoveryState = "waiting";
      return;
    }
    if (recoveryFrozen(runtime, timestamp)) {
      runtime.browserRecoveryState = "frozen-near-release";
      return;
    }
    if (timestamp - runtime.lastBrowserRecoveryAt < BROWSER_RECOVERY_COOLDOWN_MS) {
      runtime.browserRecoveryState = "cooldown";
      return;
    }
    runtime.browserRecoveryState = "recovering";
    runtime.lastBrowserRecoveryAt = timestamp;
    try {
      await ensureWorkerBrowser(runtime, runtime.lastTargetUrl, true);
      console.log(`${runtime.worker.name}: watchdog reopened its missing Chrome worker.`);
    } catch (error) {
      console.error(`${runtime.worker.name}: watchdog recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
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
    runtime.browserExpected = true;
    runtime.lastTargetUrl = startUrl;
    const alreadyRunning = extensionConnectedNow(runtime);
    await ensureWorkerBrowser(runtime, startUrl, !alreadyRunning);
    await reportCommand(runtime, decryptedCommand, "worker-launched", { alreadyRunning });
    console.log(`${runtime.worker.name}: ${alreadyRunning ? "already running" : "browser launched"}.`);
    return;
  }

  if (decryptedCommand.type === "refresh-host") {
    for (const hostRuntime of runtimes.values()) {
      hostRuntime.clockSamples.length = 0;
      hostRuntime.clockOffsetMs = 0;
      hostRuntime.clockRoundTripMs = null;
      scheduleHeartbeat(hostRuntime, 0);
    }
    await reportCommand(runtime, decryptedCommand, "host-refreshed", {
      workers: runtimes.size,
    });
    console.log(`${config.hostName}: refreshed ${runtimes.size} controller channels.`);
    return;
  }

  if (decryptedCommand.type === "calibrate-host") {
    console.log(`${config.hostName}: running a ${CALIBRATION_DURATION_MS / 1_000}-second local capacity check.`);
    const calibration = await calibrateHost();
    await reportCommand(runtime, decryptedCommand, "host-calibrated", { ...calibration });
    console.log(`${config.hostName}: ${calibration.summary}`);
    return;
  }

  runtime.pendingCommand = decryptedCommand;
  if (decryptedCommand.type === "open-event" && typeof decryptedCommand.payload.eventUrl === "string") {
    runtime.lastTargetUrl = decryptedCommand.payload.eventUrl;
  }
  if (decryptedCommand.type === "arm-live") {
    runtime.activeRunId = decryptedCommand.runId;
    const releaseAt = Number(decryptedCommand.payload.releaseAt);
    runtime.activeRunReleaseAt = Number.isFinite(releaseAt) ? releaseAt : null;
  }
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
        hostBuildId: BUILD_ID,
        hostId: config.hostId,
        hostName: config.hostName,
        workerId: runtime.worker.workerId,
        workerIndex: runtime.worker.workerIndex,
        workerCount: config.workers.length,
        hostResources: reportedHostResources(),
        hostCalibration,
        browserWatchdog: {
          enabled: true,
          state: runtime.browserRecoveryState,
          lastRecoveryAt: runtime.lastBrowserRecoveryAt || null,
          frozenNearRelease: recoveryFrozen(runtime, Date.now()),
        },
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
    buildId: BUILD_ID,
    hostId: config.hostId,
    hostName: config.hostName,
    port,
    resources: hostResources(),
    calibration: hostCalibration,
    workers: [...runtimes.values()].map((runtime) => ({
      id: runtime.worker.workerId,
      name: runtime.worker.name,
      controllerOnline: runtime.controllerOnline,
      approvalPending: runtime.approvalPending,
      extensionConnected: extensionConnectedNow(runtime),
      pageConnected: pageConnectedNow(runtime),
      pendingCommand: runtime.pendingCommand?.type ?? null,
      pollIntervalMs: desiredPollIntervalMs(runtime),
      browserExpected: runtime.browserExpected,
      browserRecoveryState: runtime.browserRecoveryState,
    })),
  });
});

app.post("/extension/poll", (request, response) => {
  const runtime = runtimeForRequest(request)!;
  const timestamp = Date.now();
  const wasPageConnected = pageConnectedNow(runtime);
  recordExtensionPoll(runtime, timestamp);
  runtime.extensionSeenAt = timestamp;
  runtime.browserExpected = true;
  runtime.browserRecoveryState = "watching";
  runtime.extensionStatus =
    request.body?.status && typeof request.body.status === "object" ? request.body.status : {};
  const observedEventUrl = runtime.extensionStatus.eventUrl;
  if (typeof observedEventUrl === "string") {
    try {
      const parsedEventUrl = new URL(observedEventUrl);
      if (parsedEventUrl.protocol === "https:" && parsedEventUrl.hostname === "posh.vip" && parsedEventUrl.pathname.startsWith("/e/")) {
        runtime.lastTargetUrl = parsedEventUrl.toString();
      }
    } catch {
      // Keep the last controller-approved event URL when the page reports an invalid URL.
    }
  }
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
  runtime.browserExpected = true;
  runtime.browserRecoveryState = "watching";
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
    if (
      runtime.activeRunId &&
      runtime.activeRunId === request.body?.runId &&
      [
        "stopped",
        "failed",
        "inspection-complete",
        "submitted",
        "submitted-unconfirmed",
        "confirmed",
        "already-reserved",
        "local-override",
      ].includes(String(request.body?.phase))
    ) {
      runtime.activeRunId = null;
      runtime.activeRunReleaseAt = null;
    }
    response.json(result);
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const server = app.listen(port, "127.0.0.1", () => {
  console.log(`AUTOBOT profile host ${BUILD_ID}: ${config.hostName}`);
  console.log(`Local profile bridge: http://127.0.0.1:${port}`);
  console.log(`${config.workers.length} isolated Chrome workers configured.`);
});

await Promise.all([...runtimes.values()].map((runtime) => runHeartbeat(runtime)));
const browserWatchdogTimer = setInterval(() => {
  void runBrowserWatchdog();
}, BROWSER_WATCHDOG_INTERVAL_MS);

function shutdown() {
  stopping = true;
  for (const runtime of runtimes.values()) {
    if (runtime.heartbeatTimer) clearTimeout(runtime.heartbeatTimer);
  }
  clearInterval(browserWatchdogTimer);
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
