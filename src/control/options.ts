import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type DeviceConfig = {
  controllerUrl: string;
  deviceId: string;
  token: string;
  name: string;
  publicKeyPem?: string;
  privateKeyPem?: string;
};

export function readOption(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return fallback;
}

export function configPath(): string {
  const explicit = readOption("config");
  if (explicit) return path.resolve(explicit);
  const home = os.homedir();
  const directory =
    process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA ?? process.env.APPDATA ?? path.join(home, "AppData", "Local"), "AUTOBOT")
      : process.platform === "darwin"
        ? path.join(home, "Library", "Application Support", "AUTOBOT")
        : path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "autobot");
  const stable = path.join(directory, "device.json");
  const legacy = path.resolve("config/device.json");
  if (!existsSync(stable) && existsSync(legacy)) {
    mkdirSync(directory, { recursive: true });
    copyFileSync(legacy, stable);
    chmodSync(stable, 0o600);
  }
  return stable;
}

export function normalizeControllerUrl(value: string): string {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("Controller URL must use HTTPS, except for localhost development.");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
