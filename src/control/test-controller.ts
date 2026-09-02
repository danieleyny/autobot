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

async function claimDevice(code: string, name: string) {
  const keys = generateDeviceKeyPair();
  const device = await jsonRequest("/api/device", {
    action: "pair",
    code,
    name,
    version: "0.10.0-test",
    publicKey: keys.publicKeyPem,
  });
  return {
    approvalStatus: String(device.approvalStatus),
    id: String(device.deviceId),
    token: String(device.token),
    keys,
  };
}

async function poll(token: string, keys: DeviceKeyPair, eventTitle = "AUTOBOT Classroom Test Drop") {
  return jsonRequest(
    "/api/device",
    {
      action: "poll",
      version: "0.10.0-test",
      publicKey: keys.publicKeyPem,
      status: {
        bridgeOnline: true,
        extensionConnected: true,
        controlConnected: true,
        controlEnabled: true,
        pageReady: true,
        eventUrl: "https://posh.vip/e/test-release",
        eventTitle,
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
  const eventTitle = `AUTOBOT Lease Test ${crypto.randomUUID().slice(0, 8)}`;
  const enrollment = await jsonRequest(
    "/api/control",
    { action: "create-enrollment", label: "Controller test fleet", maxDevices: 2 },
    { cookie },
  );
  const executorOne = await claimDevice(String(enrollment.code), `Executor One ${crypto.randomUUID().slice(0, 8)}`);
  const executorTwo = await claimDevice(String(enrollment.code), `Executor Two ${crypto.randomUUID().slice(0, 8)}`);
  assert.equal(executorOne.approvalStatus, "pending");
  assert.equal(executorTwo.approvalStatus, "pending");
  const pendingPoll = await poll(executorOne.token, executorOne.keys, eventTitle);
  assert.equal(pendingPoll.approvalPending, true);
  assert.equal(pendingPoll.command, null);
  await jsonRequest(
    "/api/device",
    { action: "report", phase: "status" },
    { token: executorOne.token, expectedStatus: 403 },
  );
  const rejectedKeys = generateDeviceKeyPair();
  await jsonRequest(
    "/api/device",
    {
      action: "pair",
      code: enrollment.code,
      name: "Over capacity",
      version: "0.10.0-test",
      publicKey: rejectedKeys.publicKeyPem,
    },
    { expectedStatus: 401 },
  );
  await jsonRequest("/api/control", { action: "approve-device", deviceId: executorOne.id }, { cookie });
  await jsonRequest("/api/control", { action: "approve-device", deviceId: executorTwo.id }, { cookie });
  await poll(executorOne.token, executorOne.keys, eventTitle);
  await poll(executorTwo.token, executorTwo.keys, eventTitle);

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
      deviceIds: [executorOne.id, executorTwo.id],
      confirmEventTitle: eventTitle,
      encryptedSecrets: {
        [executorOne.id]: encryptForDevice(eventPassword, executorOne.keys.publicKeyPem),
        [executorTwo.id]: encryptForDevice(eventPassword, executorTwo.keys.publicKeyPem),
      },
    },
    { cookie },
  );

  const executorOnePoll = await poll(executorOne.token, executorOne.keys, eventTitle);
  const executorTwoPoll = await poll(executorTwo.token, executorTwo.keys, eventTitle);
  const executorOneCommand = executorOnePoll.command as Record<string, unknown>;
  const executorTwoCommand = executorTwoPoll.command as Record<string, unknown>;
  assert.equal(executorOneCommand.type, "arm-live");
  assert.equal(executorTwoCommand.type, "arm-live");
  assert.notEqual(
    (executorOneCommand.payload as Record<string, unknown>).leaseId,
    (executorTwoCommand.payload as Record<string, unknown>).leaseId,
  );
  const redelivered = await poll(executorOne.token, executorOne.keys, eventTitle);
  assert.equal((redelivered.command as Record<string, unknown>).id, executorOneCommand.id);
  const executorOnePayload = executorOneCommand.payload as Record<string, unknown>;
  const executorTwoPayload = executorTwoCommand.payload as Record<string, unknown>;
  assert.equal(executorOnePayload.eventPassword, undefined);
  assert.equal(executorTwoPayload.eventPassword, undefined);
  assert.equal(
    decryptForDevice(String(executorOnePayload.eventSecret), executorOne.keys.privateKeyPem),
    eventPassword,
  );
  assert.equal(
    decryptForDevice(String(executorTwoPayload.eventSecret), executorTwo.keys.privateKeyPem),
    eventPassword,
  );
  assert.equal(executorOnePayload.releaseAt, executorTwoPayload.releaseAt);
  assert.equal(executorOnePayload.fleetSize, 2);

  await jsonRequest(
    "/api/device",
    {
      action: "report",
      commandId: executorOneCommand.id,
      runId,
      phase: "execution-started",
    },
    { token: executorOne.token },
  );
  await jsonRequest(
    "/api/device",
    {
      action: "report",
      commandId: executorTwoCommand.id,
      runId,
      phase: "execution-started",
    },
    { token: executorTwo.token },
  );
  await jsonRequest(
    "/api/device",
    {
      action: "report",
      commandId: executorOneCommand.id,
      runId,
      phase: "submitted",
      detail: { test: true },
    },
    { token: executorOne.token },
  );

  const partialState = await jsonRequest("/api/control", null, { cookie });
  const partialRun = (partialState.runs as Array<Record<string, unknown>>).find((item) => item.id === runId);
  assert.equal(partialRun?.status, "armed");

  await jsonRequest(
    "/api/device",
    {
      action: "report",
      commandId: executorTwoCommand.id,
      runId,
      phase: "submitted",
      detail: { test: true },
    },
    { token: executorTwo.token },
  );

  const finalState = await jsonRequest("/api/control", null, { cookie });
  const run = (finalState.runs as Array<Record<string, unknown>>).find((item) => item.id === runId);
  const leases = (finalState.leases as Array<Record<string, unknown>>).filter((item) => item.run_id === runId);
  assert.equal(run?.status, "completed");
  assert.equal(leases.length, 2);
  assert.ok(leases.every((lease) => lease.status === "submitted"));

  await jsonRequest(
    "/api/control",
    { action: "remove-device", deviceId: executorTwo.id },
    { cookie },
  );
  const afterRemoval = await jsonRequest("/api/control", null, { cookie });
  assert.ok(!(afterRemoval.devices as Array<Record<string, unknown>>).some((device) => device.id === executorTwo.id));
  console.log("Control integration passed: batch enrollment approval, capacity limit, encrypted two-device fleet, reliable redelivery, results, and revocation.");
} finally {
  if (server && !server.killed) server.kill("SIGTERM");
}
