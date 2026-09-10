import { chmod, readFile, writeFile } from "node:fs/promises";
import express from "express";
import { decryptForDevice, generateDeviceKeyPair } from "./encryption.js";
import { configPath, readOption, type DeviceConfig } from "./options.js";

type ControllerCommand = {
  id: string;
  runId: string | null;
  type: string;
  payload: Record<string, unknown>;
};

const VERSION = "0.13.0";
const BRIDGE_PROTOCOL_VERSION = "0.12.2";
const ACTIVE_POLL_INTERVAL_MS = 1_000;
const IDLE_POLL_INTERVAL_MS = 15_000;
const CLOCK_SAMPLE_LIMIT = 8;

const file = configPath();
const config = JSON.parse(await readFile(file, "utf8")) as DeviceConfig;
if (!config.publicKeyPem || !config.privateKeyPem) {
  const keyPair = generateDeviceKeyPair();
  config.publicKeyPem = keyPair.publicKeyPem;
  config.privateKeyPem = keyPair.privateKeyPem;
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
  console.log("Created this device's private encryption key for command-center passwords.");
}
const port = Number(readOption("port", "4181"));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Device bridge port is invalid.");

let extensionStatus: Record<string, unknown> = {};
let extensionSeenAt = 0;
let backgroundSeenAt = 0;
let backgroundControlEnabled = true;
let pendingCommand: ControllerCommand | null = null;
let controllerOnline = false;
let approvalPending = false;
let stopping = false;
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatDueAt = Number.POSITIVE_INFINITY;
let heartbeatInFlight = false;
let clockOffsetMs = 0;
let clockRoundTripMs: number | null = null;
const clockSamples: Array<{ offsetMs: number; roundTripMs: number }> = [];

function pageConnectedNow() {
  return Date.now() - extensionSeenAt < 4_000;
}

function extensionConnectedNow() {
  return pageConnectedNow() || Date.now() - backgroundSeenAt < 4_000;
}

function desiredPollIntervalMs() {
  return pageConnectedNow() || pendingCommand ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
}

function updateClockEstimate(serverTime: unknown, startedAt: number, finishedAt: number) {
  const serverTimestamp = Number(serverTime);
  if (!Number.isFinite(serverTimestamp)) return;
  const roundTripMs = Math.max(0, finishedAt - startedAt);
  if (roundTripMs > 5_000) return;
  const observedOffsetMs = serverTimestamp - (startedAt + finishedAt) / 2;
  // If a laptop's clock is corrected while the bridge is already running,
  // discard samples from the old clock instead of waiting for them to age out.
  if (clockSamples.length && Math.abs(observedOffsetMs - clockOffsetMs) > 1_000) {
    clockSamples.length = 0;
  }
  clockSamples.push({
    offsetMs: observedOffsetMs,
    roundTripMs,
  });
  if (clockSamples.length > CLOCK_SAMPLE_LIMIT) clockSamples.shift();
  const best = [...clockSamples].sort((left, right) => left.roundTripMs - right.roundTripMs)[0];
  if (!best) return;
  clockOffsetMs = Math.round(best.offsetMs);
  clockRoundTripMs = Math.round(best.roundTripMs);
}

function scheduleHeartbeat(delayMs = desiredPollIntervalMs()) {
  if (stopping) return;
  const dueAt = Date.now() + Math.max(0, delayMs);
  if (heartbeatTimer && heartbeatDueAt <= dueAt) return;
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  heartbeatDueAt = dueAt;
  heartbeatTimer = setTimeout(() => {
    heartbeatTimer = null;
    heartbeatDueAt = Number.POSITIVE_INFINITY;
    void runHeartbeat();
  }, Math.max(0, delayMs));
}

async function runHeartbeat() {
  if (heartbeatInFlight || stopping) return;
  heartbeatInFlight = true;
  try {
    await heartbeat();
  } finally {
    heartbeatInFlight = false;
    scheduleHeartbeat();
  }
}

async function controllerRequest(body: Record<string, unknown>) {
  const response = await fetch(`${config.controllerUrl}/api/device`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  const result = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(result.error || `Controller returned HTTP ${response.status}.`));
  return result;
}

async function heartbeat() {
  if (stopping) return;
  const requestStartedAt = Date.now();
  try {
    const pageConnected = pageConnectedNow();
    const extensionConnected = extensionConnectedNow();
    const pageStatus = pageConnected ? extensionStatus : {};
    const pollIntervalMs = desiredPollIntervalMs();
    const result = await controllerRequest({
      action: "poll",
      version: VERSION,
      publicKey: config.publicKeyPem,
      status: {
        ...pageStatus,
        bridgeOnline: true,
        extensionConnected,
        controlConnected:
          extensionConnected &&
          backgroundControlEnabled !== false &&
          pageStatus.controlEnabled !== false,
        pageReady: pageConnected && pageStatus.pageReady === true,
        bridgePort: port,
        pollIntervalMs,
      },
    });
    updateClockEstimate(result.serverTime, requestStartedAt, Date.now());
    controllerOnline = true;
    const wasApprovalPending = approvalPending;
    approvalPending = result.approvalPending === true;
    if (approvalPending && !wasApprovalPending) {
      console.log("Waiting for this laptop to be approved in the Command Center.");
    }
    if (!approvalPending && wasApprovalPending) {
      console.log("This laptop was approved for fleet control.");
    }
    if (!pendingCommand && result.command && typeof result.command === "object") {
      const command = result.command as ControllerCommand;
      try {
        const payload = { ...command.payload };
        if (typeof payload.eventSecret === "string") {
          payload.eventPassword = decryptForDevice(payload.eventSecret, config.privateKeyPem!);
          delete payload.eventSecret;
        }
        pendingCommand = { ...command, payload };
        console.log(`Received ${pendingCommand.type} command ${pendingCommand.id}.`);
      } catch (error) {
        console.error(`Could not decrypt command ${command.id}: ${error instanceof Error ? error.message : String(error)}`);
        await controllerRequest({
          action: "report",
          commandId: command.id,
          runId: command.runId,
          phase: "failed",
          detail: { message: "This device could not decrypt the command-center password." },
        }).catch(() => {});
      }
    }
  } catch (error) {
    if (controllerOnline) {
      console.error(`Controller connection lost: ${error instanceof Error ? error.message : String(error)}`);
    }
    controllerOnline = false;
  }
}

const app = express();
app.use(express.json({ limit: "64kb" }));

app.use((request, response, next) => {
  const origin = request.get("origin");
  if (origin && !origin.startsWith("chrome-extension://")) {
    response.status(403).json({ error: "The local bridge only accepts extension requests." });
    return;
  }
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Headers", "content-type,x-autobot-bridge");
  if (request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }
  if (
    request.path.startsWith("/extension/") &&
    request.get("x-autobot-bridge") !== BRIDGE_PROTOCOL_VERSION
  ) {
    response.status(401).json({ error: "Extension bridge version is missing." });
    return;
  }
  next();
});

app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    device: config.name,
    controllerOnline,
    approvalPending,
    extensionConnected: extensionConnectedNow(),
    pendingCommand: pendingCommand?.type ?? null,
    pollIntervalMs: desiredPollIntervalMs(),
    clockOffsetMs,
    clockRoundTripMs,
  });
});

app.post("/extension/poll", (request, response) => {
  const wasPageConnected = pageConnectedNow();
  extensionSeenAt = Date.now();
  extensionStatus = request.body?.status && typeof request.body.status === "object" ? request.body.status : {};
  if (!wasPageConnected) scheduleHeartbeat(0);
  response.json({
    connected: controllerOnline,
    approvalPending,
    deviceName: config.name,
    clockOffsetMs,
    clockRoundTripMs,
    command:
      extensionStatus.controlEnabled === false || pendingCommand?.type === "open-event"
        ? null
        : pendingCommand,
  });
});

app.post("/extension/navigation-poll", (request, response) => {
  backgroundSeenAt = Date.now();
  backgroundControlEnabled = request.body?.controlEnabled !== false;
  response.json({
    connected: controllerOnline,
    approvalPending,
    deviceName: config.name,
    clockOffsetMs,
    clockRoundTripMs,
    command:
      backgroundControlEnabled && pendingCommand?.type === "open-event"
        ? pendingCommand
        : null,
  });
});

app.post("/extension/report", async (request, response) => {
  try {
    const commandId = typeof request.body?.commandId === "string" ? request.body.commandId : "";
    const result = await controllerRequest({
      action: "report",
      commandId,
      runId: request.body?.runId,
      phase: request.body?.phase,
      detail: request.body?.detail,
    });
    if (
      pendingCommand?.id === commandId &&
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
      pendingCommand = null;
    }
    response.json(result);
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const server = app.listen(port, "127.0.0.1", () => {
  console.log(`AUTOBOT device bridge v${VERSION}: ${config.name}`);
  console.log(`Local extension bridge: http://127.0.0.1:${port}`);
  console.log(`Controller: ${config.controllerUrl}`);
});

await runHeartbeat();

function shutdown() {
  stopping = true;
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
