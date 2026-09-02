import { readFile } from "node:fs/promises";
import { configPath, type DeviceConfig } from "./options.js";

const config = JSON.parse(await readFile(configPath(), "utf8")) as DeviceConfig;

async function request(body: Record<string, unknown>) {
  const response = await fetch(`${config.controllerUrl}/api/device`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(result.error || `HTTP ${response.status}`));
  return result;
}

console.log(`Simulating ${config.name}. Press Ctrl+C to stop.`);
setInterval(async () => {
  const result = await request({
    action: "poll",
    version: "0.9.0-sim",
    publicKey: config.publicKeyPem,
    status: {
      bridgeOnline: true,
      extensionConnected: true,
      controlConnected: true,
      controlEnabled: true,
      pageReady: true,
      eventTitle: "AUTOBOT Classroom Test Drop",
      armed: false,
      simulation: true,
    },
  });
  const command = result.command as { id: string; runId: string; type: string } | undefined;
  if (command) {
    console.log(`Simulated command: ${command.type}`);
    await request({
      action: "report",
      commandId: command.id,
      runId: command.runId,
      phase: command.type === "standby" ? "standby" : "accepted",
      detail: { simulation: true },
    });
  }
}, 1_000);
