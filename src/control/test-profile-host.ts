import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import type { ProfileHostConfig, ProfileWorkerConfig } from "./profile-host-options.js";
import { promisify } from "node:util";

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "autobot-profile-host-test-"));
const bridgePort = 43_000 + Math.floor(Math.random() * 1_000);
const commands = new Map<string, Record<string, unknown> | null>();
const reports: Array<{ token: string; commandId: string; phase: string; detail?: Record<string, unknown> }> = [];
let pairedWorkers = 0;

const controller = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  const token = String(request.headers.authorization || "").replace(/^Bearer /, "");
  response.setHeader("content-type", "application/json");
  if (body.action === "pair") {
    pairedWorkers += 1;
    const pairedToken = `setup-token-${pairedWorkers}`;
    commands.set(pairedToken, {
      id: `command-${pairedWorkers}`,
      runId: `run-${pairedWorkers}`,
      type: "inspect",
      payload: { marker: pairedWorkers },
    });
    response.end(JSON.stringify({
      approvalStatus: "approved",
      deviceId: `device-${pairedWorkers}`,
      token: pairedToken,
      name: String(body.name),
    }));
    return;
  }
  if (!commands.has(token)) {
    response.statusCode = 401;
    response.end(JSON.stringify({ error: "Unknown device" }));
    return;
  }
  if (body.action === "poll") {
    response.end(JSON.stringify({ serverTime: Date.now(), command: commands.get(token) ?? null }));
    return;
  }
  if (body.action === "report") {
    reports.push({
      token,
      commandId: String(body.commandId),
      phase: String(body.phase),
      detail: body.detail && typeof body.detail === "object" ? body.detail as Record<string, unknown> : undefined,
    });
    commands.set(token, null);
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.statusCode = 400;
  response.end(JSON.stringify({ error: "Unsupported action" }));
});

await new Promise<void>((resolve) => controller.listen(0, "127.0.0.1", resolve));
const controllerAddress = controller.address();
if (!controllerAddress || typeof controllerAddress === "string") throw new Error("Test controller did not bind.");
const controllerUrl = `http://127.0.0.1:${controllerAddress.port}`;
const configFile = path.join(temporaryDirectory, "profile-host.json");
const tsxCli = path.resolve("node_modules/tsx/dist/cli.mjs");
const setupScript = path.resolve("src/control/profile-host-setup.ts");
const agentScript = path.resolve("src/control/profile-host-agent.ts");
const execFileAsync = promisify(execFile);

await execFileAsync(process.execPath, [
  tsxCli,
  setupScript,
  `--controller=${controllerUrl}`,
  "--code=TESTCODE",
  "--name=Host Test",
  "--workers=2",
  `--host-config=${configFile}`,
  `--host-root=${temporaryDirectory}`,
  "--no-onboarding",
]);
let config = JSON.parse(await readFile(configFile, "utf8")) as ProfileHostConfig;
assert.equal(config.workers.length, 2);
assert.notEqual(config.workers[0]!.workerId, config.workers[1]!.workerId);
const originalWorkerOneId = config.workers[0]!.workerId;
const originalWorkerOneProfile = config.workers[0]!.profileDirectory;
const originalWorkerTwoId = config.workers[1]!.workerId;
for (const worker of config.workers) {
  const workerConfigText = await readFile(path.join(worker.extensionDirectory, "worker-config.js"), "utf8");
  assert.match(workerConfigText, new RegExp(worker.workerId));
  assert.match(workerConfigText, new RegExp(worker.bridgeToken));
}

await execFileAsync(process.execPath, [
  tsxCli,
  setupScript,
  "--code=REPLACECODE",
  "--replace-worker=1",
  `--host-config=${configFile}`,
  `--host-root=${temporaryDirectory}`,
  "--no-onboarding",
]);
config = JSON.parse(await readFile(configFile, "utf8")) as ProfileHostConfig;
assert.notEqual(config.workers[0]!.workerId, originalWorkerOneId);
assert.equal(config.workers[0]!.profileDirectory, originalWorkerOneProfile);
assert.equal(config.workers[1]!.workerId, originalWorkerTwoId);

const child = spawn(process.execPath, [tsxCli, agentScript, `--host-config=${configFile}`, `--port=${bridgePort}`], {
  cwd: path.resolve("."),
  stdio: "pipe",
});
let childOutput = "";
child.stdout.on("data", (chunk) => {
  childOutput = `${childOutput}${String(chunk)}`.slice(-8_000);
});
child.stderr.on("data", (chunk) => {
  childOutput = `${childOutput}${String(chunk)}`.slice(-8_000);
});

async function waitForHealth() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${bridgePort}/health`);
      if (response.ok) return;
    } catch {
      // Agent is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Profile host did not start.\n${childOutput}`);
}

async function extensionRequest(workerConfig: ProfileWorkerConfig, route: string, body: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${bridgePort}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-autobot-bridge": "0.12.2",
      "x-autobot-worker": workerConfig.workerId,
      "x-autobot-worker-token": workerConfig.bridgeToken,
    },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}

try {
  await waitForHealth();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const workerOnePoll = await extensionRequest(config.workers[0]!, "/extension/poll", {
    status: { pageReady: true, controlEnabled: true },
  });
  const workerTwoPoll = await extensionRequest(config.workers[1]!, "/extension/poll", {
    status: { pageReady: true, controlEnabled: true },
  });
  assert.equal((workerOnePoll.command as Record<string, unknown>).id, "command-3");
  assert.equal((workerTwoPoll.command as Record<string, unknown>).id, "command-2");
  assert.notEqual(
    (workerOnePoll.command as Record<string, unknown>).id,
    (workerTwoPoll.command as Record<string, unknown>).id,
  );

  const rejected = await fetch(`http://127.0.0.1:${bridgePort}/extension/poll`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-autobot-bridge": "0.12.2",
      "x-autobot-worker": config.workers[0]!.workerId,
      "x-autobot-worker-token": "wrong-token",
    },
    body: JSON.stringify({ status: {} }),
  });
  assert.equal(rejected.status, 401);

  await extensionRequest(config.workers[0]!, "/extension/report", {
    commandId: "command-3",
    runId: "run-3",
    phase: "inspection-complete",
  });
  await extensionRequest(config.workers[1]!, "/extension/report", {
    commandId: "command-2",
    runId: "run-2",
    phase: "inspection-complete",
  });
  assert.deepEqual(
    reports.map((report) => `${report.token}:${report.commandId}:${report.phase}`).sort(),
    [
      "setup-token-2:command-2:inspection-complete",
      "setup-token-3:command-3:inspection-complete",
    ],
  );

  commands.set("setup-token-3", {
    id: "refresh-command",
    runId: null,
    type: "refresh-host",
    payload: {},
  });
  const refreshDeadline = Date.now() + 5_000;
  while (
    !reports.some((report) => report.commandId === "refresh-command" && report.phase === "host-refreshed") &&
    Date.now() < refreshDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(
    reports.some((report) => report.commandId === "refresh-command" && report.phase === "host-refreshed"),
    "The host refresh command should be acknowledged without involving a page worker.",
  );
  commands.set("setup-token-3", {
    id: "calibration-command",
    runId: null,
    type: "calibrate-host",
    payload: {},
  });
  let feedCalibration = true;
  const calibrationFeed = (async () => {
    while (feedCalibration) {
      await Promise.all([
        extensionRequest(config.workers[0]!, "/extension/poll", {
          status: { pageReady: true, controlEnabled: true, extensionBuildId: "v0.13.1-beta.1" },
        }),
        extensionRequest(config.workers[1]!, "/extension/poll", {
          status: { pageReady: true, controlEnabled: true, extensionBuildId: "v0.13.1-beta.1" },
        }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  })();
  const calibrationDeadline = Date.now() + 8_000;
  while (
    !reports.some((report) => report.commandId === "calibration-command" && report.phase === "host-calibrated") &&
    Date.now() < calibrationDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  feedCalibration = false;
  await calibrationFeed;
  const calibrationReport = reports.find(
    (report) => report.commandId === "calibration-command" && report.phase === "host-calibrated",
  );
  assert.ok(calibrationReport, "The host calibration command should finish locally.");
  assert.equal(calibrationReport.detail?.connectedWorkers, 2);
  assert.equal(calibrationReport.detail?.eventReadyWorkers, 2);
  assert.equal(typeof calibrationReport.detail?.recommendedWorkerCount, "number");
  const healthResponse = await fetch(`http://127.0.0.1:${bridgePort}/health`);
  const health = (await healthResponse.json()) as Record<string, unknown>;
  assert.equal(health.ok, true);
  assert.equal(health.buildId, "v0.13.1-beta.1");
  assert.equal((health.workers as unknown[]).length, 2);
  assert.equal(typeof (health.resources as Record<string, unknown>).totalMemoryMb, "number");
  assert.equal((health.calibration as Record<string, unknown>).connectedWorkers, 2);
  assert.equal(
    ((health.workers as Array<Record<string, unknown>>)[0]?.browserRecoveryState),
    "watching",
  );
  console.log("Profile host integration passed: setup, replacement, isolated routing, calibration, watchdog state, host refresh, diagnostics, and bridge-token rejection.");
} finally {
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await new Promise<void>((resolve) => controller.close(() => resolve()));
  await rm(temporaryDirectory, { recursive: true, force: true });
}
