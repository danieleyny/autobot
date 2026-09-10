import { access, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { profileHostConfigPath } from "./profile-host-options.js";

const remove = process.argv.includes("--remove");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const nodeExecutable = process.execPath;
const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const agentScript = path.join(projectRoot, "src", "control", "profile-host-agent.ts");
const hostConfig = profileHostConfigPath();
const logsDirectory = path.join(projectRoot, "artifacts");

if (!remove) {
  await access(hostConfig).catch(() => {
    throw new Error("Configure this profile host before installing startup recovery.");
  });
  await access(tsxCli);
}

function xml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function installMac() {
  const target = path.join(os.homedir(), "Library", "LaunchAgents", "vip.posh.autobot-profile-host.plist");
  if (remove) {
    await rm(target, { force: true });
    return target;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await mkdir(logsDirectory, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>vip.posh.autobot-profile-host</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodeExecutable)}</string>
    <string>${xml(tsxCli)}</string>
    <string>${xml(agentScript)}</string>
    <string>--host-config=${xml(hostConfig)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(projectRoot)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(path.join(logsDirectory, "profile-host.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logsDirectory, "profile-host-error.log"))}</string>
</dict>
</plist>
`;
  await writeFile(target, plist, { encoding: "utf8", mode: 0o644 });
  return target;
}

async function installWindows() {
  const appData = process.env.APPDATA;
  if (!appData) throw new Error("Windows APPDATA directory is unavailable.");
  const startupDirectory = path.join(
    appData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
  );
  const target = path.join(startupDirectory, "AUTOBOT-Profile-Host.vbs");
  const supportDirectory = path.join(process.env.LOCALAPPDATA ?? appData, "AUTOBOT");
  const watchdog = path.join(supportDirectory, "AUTOBOT-Profile-Host-Watchdog.cmd");
  if (remove) {
    await Promise.all([rm(target, { force: true }), rm(watchdog, { force: true })]);
    return target;
  }
  await mkdir(startupDirectory, { recursive: true });
  await mkdir(supportDirectory, { recursive: true });
  const script = `@echo off\r\nsetlocal\r\ntitle AUTOBOT Profile Host\r\n:autobot_restart\r\n"${nodeExecutable}" "${tsxCli}" "${agentScript}" --host-config="${hostConfig}"\r\ntimeout /t 5 /nobreak >nul\r\ngoto autobot_restart\r\n`;
  const launcher = `Set shell = CreateObject("WScript.Shell")\r\nshell.Run "cmd.exe /d /c " & Chr(34) & "${watchdog.replaceAll('"', '""')}" & Chr(34), 0, False\r\n`;
  await writeFile(watchdog, script, "utf8");
  await writeFile(target, launcher, "utf8");
  return target;
}

async function installLinux() {
  const target = path.join(os.homedir(), ".config", "autostart", "autobot-profile-host.desktop");
  if (remove) {
    await rm(target, { force: true });
    return target;
  }
  await mkdir(path.dirname(target), { recursive: true });
  const entry = `[Desktop Entry]
Type=Application
Name=AUTOBOT Profile Host
Comment=Local bridge for isolated AUTOBOT Chrome workers
Exec=${shellQuote(nodeExecutable)} ${shellQuote(tsxCli)} ${shellQuote(agentScript)} --host-config=${shellQuote(hostConfig)}
Terminal=false
X-GNOME-Autostart-enabled=true
`;
  await writeFile(target, entry, { encoding: "utf8", mode: 0o644 });
  return target;
}

const target =
  process.platform === "darwin"
    ? await installMac()
    : process.platform === "win32"
      ? await installWindows()
      : await installLinux();

if (remove) {
  console.log(`Removed AUTOBOT profile-host startup registration: ${target}`);
} else {
  console.log(`Installed AUTOBOT profile-host startup registration: ${target}`);
  console.log("The profile host will start automatically at the next user login.");
  console.log("For this login session, start it now with: npm run profiles:host");
}
