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
const reports: Array<{ token: string; commandId: string; phase: string }> = [];
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
    reports.push({ token, commandId: String(body.commandId), phase: String(body.phase) });
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
  const healthResponse = await fetch(`http://127.0.0.1:${bridgePort}/health`);
  const health = (await healthResponse.json()) as Record<string, unknown>;
  assert.equal(health.ok, true);
  assert.equal((health.workers as unknown[]).length, 2);
  assert.equal(typeof (health.resources as Record<string, unknown>).totalMemoryMb, "number");
  console.log("Profile host integration passed: setup, replacement, isolated routing, independent commands, host refresh, diagnostics, and bridge-token rejection.");
} finally {
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await new Promise<void>((resolve) => controller.close(() => resolve()));
  await rm(temporaryDirectory, { recursive: true, force: true });
}
