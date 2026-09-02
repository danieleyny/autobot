import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateDeviceKeyPair } from "./encryption.js";
import { configPath, normalizeControllerUrl, readOption, type DeviceConfig } from "./options.js";

const controller = readOption("controller");
const code = readOption("code");
const name = readOption("name");

if (!controller || !code || !name) {
  throw new Error(
    "Usage: npm run device:pair -- --controller=https://YOUR-CONTROLLER --code=PAIRCODE --name=\"Studio Mac\"",
  );
}

const controllerUrl = normalizeControllerUrl(controller);
const keyPair = generateDeviceKeyPair();
const response = await fetch(`${controllerUrl}/api/device`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    action: "pair",
    code,
    name,
    version: "0.8.0",
    publicKey: keyPair.publicKeyPem,
  }),
});
const result = (await response.json()) as {
  error?: string;
  deviceId?: string;
  token?: string;
  name?: string;
};
if (!response.ok || !result.deviceId || !result.token) {
  throw new Error(result.error || `Pairing failed with HTTP ${response.status}.`);
}

const target = configPath();
const deviceConfig: DeviceConfig = {
  controllerUrl,
  deviceId: result.deviceId,
  token: result.token,
  name: result.name || name,
  publicKeyPem: keyPair.publicKeyPem,
  privateKeyPem: keyPair.privateKeyPem,
};
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(deviceConfig, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
await chmod(target, 0o600).catch(() => {});

console.log(`Paired ${deviceConfig.name}.`);
console.log(`Private device credentials and encryption key saved to ${target}.`);
console.log("Start the optional bridge with: npm run device");
