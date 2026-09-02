import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CliOptions, EventConfig } from "./types.js";

function stringArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

export function cliOptions(): CliOptions {
  return {
    configPath: resolve(stringArg("config") ?? "config/event.example.json"),
    execute: process.argv.includes("--execute"),
    headed: !process.argv.includes("--headless")
  };
}

export async function loadConfig(path: string): Promise<EventConfig> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<EventConfig>;
  const required = [
    "provider",
    "eventUrl",
    "expectedEventTitle",
    "expectedTicketName",
    "organizerOwned",
    "permissionConfirmed",
    "maxRefreshes",
    "refreshIntervalMs"
  ] as const;

  for (const key of required) {
    if (parsed[key] === undefined || parsed[key] === "") {
      throw new Error(`Missing required config field: ${key}`);
    }
  }

  if (parsed.provider !== "mock" && parsed.provider !== "posh") {
    throw new Error("provider must be either 'mock' or 'posh'");
  }

  const url = new URL(parsed.eventUrl as string);
  if (parsed.provider === "posh") {
    if (url.protocol !== "https:" || url.hostname !== "posh.vip" || !url.pathname.startsWith("/e/")) {
      throw new Error("A POSH target must be an https://posh.vip/e/... event URL");
    }
  } else if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("The mock provider may only target localhost");
  }

  if ((parsed.maxRefreshes as number) < 0 || (parsed.maxRefreshes as number) > 10) {
    throw new Error("maxRefreshes must be between 0 and 10");
  }
  if ((parsed.refreshIntervalMs as number) < 1500) {
    throw new Error("refreshIntervalMs must be at least 1500ms");
  }

  return parsed as EventConfig;
}

export function assertExecutionAllowed(config: EventConfig, execute: boolean): void {
  if (!execute) return;
  if (!config.organizerOwned) {
    throw new Error("Execution is blocked: the event must be organizer-owned.");
  }
  if (config.provider === "posh" && !config.permissionConfirmed) {
    throw new Error(
      "Live POSH submission is blocked until POSH has confirmed this controlled test is permitted."
    );
  }
}
