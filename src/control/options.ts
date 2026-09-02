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
  return path.resolve(readOption("config", "config/device.json")!);
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
