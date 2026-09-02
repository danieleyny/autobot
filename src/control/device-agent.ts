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
let pendingCommand: ControllerCommand | null = null;
let controllerOnline = false;
let stopping = false;

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
  try {
    const extensionConnected = Date.now() - extensionSeenAt < 4_000;
    const result = await controllerRequest({
      action: "poll",
      version: "0.9.0",
      publicKey: config.publicKeyPem,
      status: {
        ...extensionStatus,
        bridgeOnline: true,
        extensionConnected,
        controlConnected: extensionConnected && extensionStatus.controlEnabled !== false,
        bridgePort: port,
      },
    });
    controllerOnline = true;
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
  if (request.path.startsWith("/extension/") && request.get("x-autobot-bridge") !== "0.9.0") {
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
    extensionConnected: Date.now() - extensionSeenAt < 4_000,
    pendingCommand: pendingCommand?.type ?? null,
  });
});

app.post("/extension/poll", (request, response) => {
  extensionSeenAt = Date.now();
  extensionStatus = request.body?.status && typeof request.body.status === "object" ? request.body.status : {};
  response.json({
    connected: controllerOnline,
    deviceName: config.name,
    command: extensionStatus.controlEnabled === false ? null : pendingCommand,
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
        "standby",
        "stopped",
        "failed",
        "inspection-complete",
        "submitted",
        "submitted-unconfirmed",
        "confirmed",
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
  console.log(`AUTOBOT device bridge v0.9.0: ${config.name}`);
  console.log(`Local extension bridge: http://127.0.0.1:${port}`);
  console.log(`Controller: ${config.controllerUrl}`);
});

const timer = setInterval(() => heartbeat().catch(() => {}), 1_000);
await heartbeat();

function shutdown() {
  stopping = true;
  clearInterval(timer);
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
