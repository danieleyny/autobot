import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readOption, type DeviceConfig } from "./options.js";

export type ProfileWorkerConfig = DeviceConfig & {
  workerId: string;
  workerIndex: number;
  bridgeToken: string;
  profileDirectory: string;
  extensionDirectory: string;
};

export type ProfileHostConfig = {
  version: string;
  hostId: string;
  hostName: string;
  controllerUrl: string;
  bridgePort: number;
  desiredWorkerCount: number;
  workers: ProfileWorkerConfig[];
};

export function autobotSupportDirectory(): string {
  const home = os.homedir();
  return process.platform === "win32"
    ? path.join(
        process.env.LOCALAPPDATA ?? process.env.APPDATA ?? path.join(home, "AppData", "Local"),
        "AUTOBOT",
      )
    : process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "AUTOBOT")
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "autobot");
}

export function profileHostConfigPath(): string {
  const explicit = readOption("host-config");
  return explicit
    ? path.resolve(explicit)
    : path.join(autobotSupportDirectory(), "profile-host.json");
}

export function profileHostIsConfigured(): boolean {
  return existsSync(profileHostConfigPath());
}
