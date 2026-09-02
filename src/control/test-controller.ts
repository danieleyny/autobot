import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pbkdf2Sync } from "node:crypto";
import assert from "node:assert/strict";
import {
  decryptForDevice,
  encryptForDevice,
  generateDeviceKeyPair,
  type DeviceKeyPair,
} from "./encryption.js";

const origin = process.env.AUTOBOT_TEST_CONTROLLER_ORIGIN ?? "http://localhost:3000";
const testPin = process.env.AUTOBOT_TEST_PIN ?? "12345678";
const testIterations = 100_000;
const testSalt = Buffer.from("autobot-pin-test-salt", "utf8");
const testPinHash = `pbkdf2-sha256:${testIterations}:${testSalt.toString("base64url")}:${pbkdf2Sync(
  testPin,
  testSalt,
  testIterations,
  32,
  "sha256",
).toString("base64url")}`;
let server: ChildProcessWithoutNullStreams | null = null;
let serverOutput = "";

async function pinSignInCookie() {
  try {
    const response = await fetch(`${origin}/api/auth/login`, {
      body: JSON.stringify({ pin: testPin }),
      headers: { "content-type": "application/json", origin },
      method: "POST",
    });
    if (response.ok) return response.headers.get("set-cookie")?.split(";")[0] ?? "";
  } catch {
    // The server is not ready yet.
  }
  return "";
}

async function serverIsRunning() {
  try {
    const response = await fetch(`${origin}/login`, { redirect: "manual" });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const cookie = await pinSignInCookie();
    if (cookie) return cookie;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Command center did not start in time.\n${serverOutput.slice(-4_000)}`);
}

async function jsonRequest(
  path: string,
  input: Record<string, unknown> | null,
  options: { cookie?: string; token?: string; expectedStatus?: number } = {},
) {
  const response = await fetch(`${origin}${path}`, {
    method: input ? "POST" : "GET",
    headers: {
      ...(input ? { "content-type": "application/json" } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: input ? JSON.stringify(input) : undefined,
  });
  const body = (await response.json()) as Record<string, unknown>;
  const expectedStatus = options.expectedStatus ?? 200;
  assert.equal(response.status, expectedStatus, JSON.stringify(body));
  return body;
}

async function pairDevice(cookie: string, name: string) {
  const keys = generateDeviceKeyPair();
  const pairing = await jsonRequest(
    "/api/control",
    { action: "create-pairing", label: name },
    { cookie },
  );
  const device = await jsonRequest("/api/device", {
    action: "pair",
    code: pairing.code,
    name,
    version: "0.8.0-test",
    publicKey: keys.publicKeyPem,
  });
  return { id: String(device.deviceId), token: String(device.token), keys };
}

async function poll(token: string, keys: DeviceKeyPair) {
  return jsonRequest(
    "/api/device",
    {
      action: "poll",
      version: "0.8.0-test",
      publicKey: keys.publicKeyPem,
      status: {
        bridgeOnline: true,
        extensionConnected: true,
        controlConnected: true,
        controlEnabled: true,
        pageReady: true,
      },
    },
    { token },
  );
}

try {
  const alreadyRunning = await serverIsRunning();
  if (!alreadyRunning) {
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error("npm executable path is unavailable.");
    server = spawn(process.execPath, [npmCli, "run", "dev"], {
      cwd: new URL("../../control-panel/", import.meta.url),
      env: {
        ...process.env,
        AUTOBOT_PIN_HASH: testPinHash,
        AUTOBOT_SESSION_SECRET: "autobot-test-session-secret-32-bytes-minimum",
        FORCE_COLOR: "0",
      },
      stdio: "pipe",
    });
    server.stdout.on("data", (chunk) => {
      serverOutput = `${serverOutput}${String(chunk)}`.slice(-12_000);
    });
    server.stderr.on("data", (chunk) => {
      serverOutput = `${serverOutput}${String(chunk)}`.slice(-12_000);
    });
    server.on("error", (error) => {
      serverOutput = `${serverOutput}\n${error.message}`.slice(-12_000);
    });
  }
  const cookie = alreadyRunning ? await pinSignInCookie() : await waitForServer();
  if (alreadyRunning && !cookie) {
    throw new Error("The running command center rejected the test PIN. Set AUTOBOT_TEST_PIN to its configured PIN.");
  }
  assert.ok(cookie, "The test PIN did not issue a dashboard session.");
  const primary = await pairDevice(cookie, `Primary ${crypto.randomUUID().slice(0, 8)}`);
  const standby = await pairDevice(cookie, `Standby ${crypto.randomUUID().slice(0, 8)}`);
  await poll(primary.token, primary.keys);
  await poll(standby.token, standby.keys);

  const eventTitle = `AUTOBOT Lease Test ${crypto.randomUUID().slice(0, 8)}`;
  const created = await jsonRequest(
    "/api/control",
    {
      action: "create-run",
      title: eventTitle,
      eventUrl: "https://posh.vip/e/test-release",
      eventTitle,
      releaseAt: Date.now() + 60_000,
      ticketStrategy: "any",
      mode: "live",
      organizerOwned: true,
      permissionConfirmed: true,
    },
    { cookie },
  );
  const runId = String(created.id);
  const eventPassword = `fleet-${crypto.randomUUID().slice(0, 8)}`;
  await jsonRequest(
    "/api/control",
    {
      action: "arm-run",
      runId,
      deviceIds: [primary.id, standby.id],
      primaryDeviceId: primary.id,
      confirmEventTitle: eventTitle,
      encryptedSecrets: {
        [primary.id]: encryptForDevice(eventPassword, primary.keys.publicKeyPem),
        [standby.id]: encryptForDevice(eventPassword, standby.keys.publicKeyPem),
      },
    },
    { cookie },
  );

  const primaryPoll = await poll(primary.token, primary.keys);
  const standbyPoll = await poll(standby.token, standby.keys);
  const primaryCommand = primaryPoll.command as Record<string, unknown>;
  const standbyCommand = standbyPoll.command as Record<string, unknown>;
  assert.equal(primaryCommand.type, "arm-live");
  assert.equal(standbyCommand.type, "standby");
  const primaryPayload = primaryCommand.payload as Record<string, unknown>;
  const standbyPayload = standbyCommand.payload as Record<string, unknown>;
  assert.equal(primaryPayload.eventPassword, undefined);
  assert.equal(standbyPayload.eventPassword, undefined);
  assert.equal(
    decryptForDevice(String(primaryPayload.eventSecret), primary.keys.privateKeyPem),
    eventPassword,
  );
  assert.equal(
    decryptForDevice(String(standbyPayload.eventSecret), standby.keys.privateKeyPem),
    eventPassword,
  );
  assert.equal(primaryPayload.releaseAt, standbyPayload.releaseAt);

  await jsonRequest(
    "/api/device",
    {
      action: "report",
      commandId: primaryCommand.id,
      runId,
      phase: "execution-started",
    },
    { token: primary.token },
  );
  await jsonRequest(
    "/api/device",
    {
      action: "report",
      commandId: standbyCommand.id,
      runId,
      phase: "execution-started",
    },
    { token: standby.token, expectedStatus: 409 },
  );
  await jsonRequest(
    "/api/device",
    {
      action: "report",
      commandId: primaryCommand.id,
      runId,
      phase: "submitted",
      detail: { test: true },
    },
    { token: primary.token },
  );

  const finalState = await jsonRequest("/api/control", null, { cookie });
  const run = (finalState.runs as Array<Record<string, unknown>>).find((item) => item.id === runId);
  const lease = (finalState.leases as Array<Record<string, unknown>>).find((item) => item.run_id === runId);
  assert.equal(run?.status, "completed");
  assert.equal(lease?.status, "submitted");
  console.log("Control integration passed: encrypted fleet setup, one primary lease, standby blocked, run completed once.");
} finally {
  if (server && !server.killed) server.kill("SIGTERM");
}
