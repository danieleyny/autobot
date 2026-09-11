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
    version: "0.13.0-test",
    publicKey: keys.publicKeyPem,
  });
  return {
    approvalStatus: String(device.approvalStatus),
    id: String(device.deviceId),
    token: String(device.token),
    keys,
  };
}

async function poll(
  token: string,
  keys: DeviceKeyPair,
  eventTitle = "AUTOBOT Classroom Test Drop",
  statusOverrides: Record<string, unknown> = {},
) {
  return jsonRequest(
    "/api/device",
    {
      action: "poll",
      version: "0.13.0-test",
      publicKey: keys.publicKeyPem,
      status: {
        bridgeOnline: true,
        extensionConnected: true,
        controlConnected: true,
        controlEnabled: true,
        pageReady: true,
        pageVisible: true,
        windowFocused: true,
        eventUrl: "https://posh.vip/e/test-release",
        eventTitle,
        pollIntervalMs: 15_000,
        profileMode: "multi",
        hostId: "test-profile-host",
        hostName: "Test Profile Host",
        workerId: `worker-${token.slice(0, 6)}`,
        workerIndex: token.charCodeAt(0) % 4 + 1,
        workerCount: 2,
        hostResources: { totalMemoryMb: 16_384, freeMemoryMb: 10_240, cpuCount: 8 },
        ...statusOverrides,
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
    const testPort = new URL(origin).port || "3000";
    server = spawn(process.execPath, [npmCli, "run", "dev", "--", "--port", testPort], {
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
  const enrollmentLifetimeMs = Number(enrollment.expiresAt) - Date.now();
  assert.ok(enrollmentLifetimeMs > 47.9 * 60 * 60_000);
  assert.ok(enrollmentLifetimeMs <= 48 * 60 * 60_000);
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
      version: "0.13.0-test",
      publicKey: rejectedKeys.publicKeyPem,
    },
    { expectedStatus: 401 },
  );
  await jsonRequest("/api/control", { action: "approve-device", deviceId: executorOne.id }, { cookie });
  await jsonRequest("/api/control", { action: "approve-device", deviceId: executorTwo.id }, { cookie });
  await poll(executorOne.token, executorOne.keys, eventTitle);
  await poll(executorTwo.token, executorTwo.keys, eventTitle);

  await jsonRequest(
    "/api/control",
    { action: "launch-workers", deviceIds: [executorOne.id, executorTwo.id] },
    { cookie },
  );
  const launchOnePoll = await poll(executorOne.token, executorOne.keys, eventTitle);
  const launchTwoPoll = await poll(executorTwo.token, executorTwo.keys, eventTitle);
  const launchOneCommand = launchOnePoll.command as Record<string, unknown>;
  const launchTwoCommand = launchTwoPoll.command as Record<string, unknown>;
  assert.equal(launchOneCommand.type, "launch-worker");
  assert.equal(launchTwoCommand.type, "launch-worker");
  assert.equal(
    (launchOneCommand.payload as Record<string, unknown>).startUrl,
    "https://posh.vip/",
  );
  await jsonRequest(
    "/api/device",
    { action: "report", commandId: launchOneCommand.id, phase: "worker-launched" },
    { token: executorOne.token },
  );
  await jsonRequest(
    "/api/device",
    { action: "report", commandId: launchTwoCommand.id, phase: "worker-launched" },
    { token: executorTwo.token },
  );
  await jsonRequest(
    "/api/control",
    { action: "refresh-profile-host", deviceId: executorOne.id },
    { cookie },
  );
  const refreshPoll = await poll(executorOne.token, executorOne.keys, eventTitle);
  const refreshCommand = refreshPoll.command as Record<string, unknown>;
  assert.equal(refreshCommand.type, "refresh-host");
  await jsonRequest(
    "/api/device",
    { action: "report", commandId: refreshCommand.id, phase: "host-refreshed" },
    { token: executorOne.token },
  );

  await jsonRequest(
    "/api/control",
    {
      action: "update-device-profile",
      deviceId: executorOne.id,
      contactEmail: "executor.one@example.com",
      contactPhone: "+1 212 555 0100",
      description: "Primary test account",
    },
    { cookie },
  );
  // Force a fresh timestamp before checking write coalescing, independently of
  // compilation/startup time spent on the preceding setup requests.
  await poll(executorOne.token, executorOne.keys, `${eventTitle} presence check`);
  await poll(executorOne.token, executorOne.keys, eventTitle);
  const directoryState = await jsonRequest("/api/control", null, { cookie });
  const directoryDevice = (directoryState.devices as Array<Record<string, unknown>>).find(
    (item) => item.id === executorOne.id,
  );
  assert.equal(directoryDevice?.contactEmail, "executor.one@example.com");
  assert.equal(directoryDevice?.contactPhone, "+1 212 555 0100");
  assert.equal(directoryDevice?.description, "Primary test account");
  assert.equal(directoryState.controllerRevision, "0.13.0");
  const firstSeenAt = Number(directoryDevice?.lastSeenAt);
  await poll(executorOne.token, executorOne.keys, eventTitle);
  const duplicateState = await jsonRequest("/api/control", null, { cookie });
  const duplicateDevice = (duplicateState.devices as Array<Record<string, unknown>>).find(
    (item) => item.id === executorOne.id,
  );
  assert.equal(duplicateDevice?.lastSeenAt, firstSeenAt, "unchanged immediate polls must not rewrite presence");
  assert.equal(duplicateDevice?.online, true);

  const nextEventUrl = "https://posh.vip/e/next-test-event";
  await jsonRequest(
    "/api/control",
    { action: "open-event", eventUrl: nextEventUrl, deviceIds: [executorOne.id, executorTwo.id] },
    { cookie },
  );
  const navigationOne = await poll(executorOne.token, executorOne.keys, eventTitle);
  const navigationTwo = await poll(executorTwo.token, executorTwo.keys, eventTitle);
  const navigationOneCommand = navigationOne.command as Record<string, unknown>;
  const navigationTwoCommand = navigationTwo.command as Record<string, unknown>;
  assert.equal(navigationOneCommand.type, "open-event");
  assert.equal(navigationTwoCommand.type, "open-event");
  assert.equal((navigationOneCommand.payload as Record<string, unknown>).eventUrl, nextEventUrl);
  assert.ok(navigationOneCommand.id, "a skipped presence write must not skip command delivery");
  await jsonRequest(
    "/api/device",
    { action: "report", commandId: navigationOneCommand.id, phase: "event-opened" },
    { token: executorOne.token },
  );
  await jsonRequest(
    "/api/device",
    { action: "report", commandId: navigationTwoCommand.id, phase: "event-opened" },
    { token: executorTwo.token },
  );

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
  await poll(executorOne.token, executorOne.keys, eventTitle, { pageVisible: false });
  const hiddenTabResult = await jsonRequest(
    "/api/control",
    {
      action: "arm-run",
      runId,
      deviceIds: [executorOne.id, executorTwo.id],
      confirmEventTitle: eventTitle,
      firstSlotCount: 1,
      encryptedSecrets: {
        [executorOne.id]: encryptForDevice(eventPassword, executorOne.keys.publicKeyPem),
        [executorTwo.id]: encryptForDevice(eventPassword, executorTwo.keys.publicKeyPem),
      },
    },
    { cookie, expectedStatus: 400 },
  );
  assert.match(String(hiddenTabResult.error), /visible/i);
  await poll(executorOne.token, executorOne.keys, eventTitle, { pageVisible: true });
  await jsonRequest(
    "/api/control",
    {
      action: "arm-run",
      runId,
      deviceIds: [executorOne.id, executorTwo.id],
      confirmEventTitle: eventTitle,
      firstSlotCount: 1,
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
  assert.ok(Number(executorOnePayload.prepareAt) <= Number(executorTwoPayload.prepareAt));
  assert.ok(Number(executorTwoPayload.prepareAt) < Number(executorTwoPayload.releaseAt));
  assert.equal(executorOnePayload.fleetSize, 2);
  assert.equal(executorOnePayload.ticketStrategy, "first");
  assert.equal(executorTwoPayload.ticketStrategy, "second");

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
  await jsonRequest(
    "/api/device",
    {
      action: "report",
      commandId: executorOneCommand.id,
      runId,
      phase: "failed",
      detail: { test: true, message: "late failure must not erase submission" },
    },
    { token: executorOne.token },
  );

  const partialState = await jsonRequest("/api/control", null, { cookie });
  const partialRun = (partialState.runs as Array<Record<string, unknown>>).find((item) => item.id === runId);
  assert.equal(partialRun?.status, "armed");
  const partialRunDevices = (partialState.runDevices as Array<Record<string, unknown>>).filter(
    (item) => item.run_id === runId,
  );
  assert.equal(partialRunDevices.find((item) => item.device_id === executorOne.id)?.status, "submitted");
  assert.equal(partialRunDevices.find((item) => item.device_id === executorOne.id)?.ticket_strategy, "first");
  assert.equal(partialRunDevices.find((item) => item.device_id === executorTwo.id)?.ticket_strategy, "second");

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
  const submittedRun = (finalState.runs as Array<Record<string, unknown>>).find((item) => item.id === runId);
  assert.equal(submittedRun?.status, "armed");

  await jsonRequest(
    "/api/device",
    {
      action: "report",
      commandId: executorOneCommand.id,
      runId,
      phase: "confirmed",
      detail: { test: true },
    },
    { token: executorOne.token },
  );
  await jsonRequest(
    "/api/device",
    {
      action: "report",
      commandId: executorTwoCommand.id,
      runId,
      phase: "submitted-unconfirmed",
      detail: { test: true },
    },
    { token: executorTwo.token },
  );

  const settledState = await jsonRequest("/api/control", null, { cookie });
  const run = (settledState.runs as Array<Record<string, unknown>>).find((item) => item.id === runId);
  const leases = (settledState.leases as Array<Record<string, unknown>>).filter((item) => item.run_id === runId);
  assert.equal(run?.status, "completed");
  assert.equal(leases.length, 2);
  assert.ok(leases.every((lease) => lease.status === "submitted"));

  await jsonRequest(
    "/api/control",
    { action: "reset-devices", deviceIds: [executorOne.id, executorTwo.id] },
    { cookie },
  );
  const resetOne = (await poll(executorOne.token, executorOne.keys, eventTitle)).command as Record<string, unknown>;
  const resetTwo = (await poll(executorTwo.token, executorTwo.keys, eventTitle)).command as Record<string, unknown>;
  assert.equal(resetOne.type, "reset");
  assert.equal(resetTwo.type, "reset");
  await jsonRequest(
    "/api/device",
    { action: "report", commandId: resetOne.id, phase: "reset-complete" },
    { token: executorOne.token },
  );
  await jsonRequest(
    "/api/device",
    { action: "report", commandId: resetTwo.id, phase: "reset-complete" },
    { token: executorTwo.token },
  );

  const rerun = await jsonRequest(
    "/api/control",
    {
      action: "create-run",
      title: `${eventTitle} reset`,
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
  const rerunId = String(rerun.id);
  await jsonRequest(
    "/api/control",
    {
      action: "arm-run",
      runId: rerunId,
      deviceIds: [executorOne.id],
      confirmEventTitle: eventTitle,
      firstSlotCount: 1,
      encryptedSecrets: {
        [executorOne.id]: encryptForDevice(eventPassword, executorOne.keys.publicKeyPem),
      },
    },
    { cookie },
  );
  await jsonRequest(
    "/api/control",
    { action: "reset-devices", deviceIds: [executorOne.id] },
    { cookie },
  );
  const resetRerun = (await poll(executorOne.token, executorOne.keys, eventTitle)).command as Record<string, unknown>;
  assert.equal(resetRerun.type, "reset", "reset must supersede an armed command");
  const resetState = await jsonRequest("/api/control", null, { cookie });
  const stoppedRerun = (resetState.runs as Array<Record<string, unknown>>).find((item) => item.id === rerunId);
  assert.equal(stoppedRerun?.status, "stopped");

  await jsonRequest(
    "/api/control",
    { action: "remove-device", deviceId: executorTwo.id },
    { cookie },
  );
  const afterRemoval = await jsonRequest("/api/control", null, { cookie });
  assert.ok(!(afterRemoval.devices as Array<Record<string, unknown>>).some((device) => device.id === executorTwo.id));
  console.log("Control integration passed: profile-host launch/refresh, remote event opening, encrypted fleet delivery, slot splitting, reset/reactivation, and revocation.");
} finally {
  if (server && !server.killed) server.kill("SIGTERM");
}
