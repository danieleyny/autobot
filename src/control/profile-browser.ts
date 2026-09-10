import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { readOption } from "./options.js";
import type { ProfileWorkerConfig } from "./profile-host-options.js";

function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

export function findChromeExecutable(): string {
  const explicit = readOption("chrome");
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!existsSync(resolved)) throw new Error(`Chrome was not found at ${resolved}.`);
    return resolved;
  }

  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          path.join(process.env.HOME ?? "", "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ]
      : process.platform === "win32"
        ? [
            path.join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe"),
            path.join(process.env["PROGRAMFILES(X86)"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
            path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
          ]
        : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (path.isAbsolute(candidate) ? existsSync(candidate) : commandAvailable(candidate)) return candidate;
  }
  throw new Error("Google Chrome was not found. Install Chrome, then run the profile-host setup again.");
}

function validateLaunchUrl(value: string): string {
  const url = new URL(value);
  const allowed =
    url.protocol === "chrome:" ||
    (url.protocol === "https:" && ["posh.vip", "www.posh.vip"].includes(url.hostname)) ||
    (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname));
  if (!allowed) throw new Error("Profile workers may open only Chrome, localhost, or POSH pages.");
  return url.toString();
}

export async function launchWorkerBrowser(worker: ProfileWorkerConfig, targetUrl: string): Promise<void> {
  await mkdir(worker.profileDirectory, { recursive: true });
  const chrome = findChromeExecutable();
  const url = validateLaunchUrl(targetUrl);
  const child = spawn(
    chrome,
    [
      `--user-data-dir=${worker.profileDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      url,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}
