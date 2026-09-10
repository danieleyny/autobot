import { access, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configPath } from "./options.js";

const remove = process.argv.includes("--remove");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const nodeExecutable = process.execPath;
const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const agentScript = path.join(projectRoot, "src", "control", "device-agent.ts");
const deviceConfig = configPath();
const logsDirectory = path.join(projectRoot, "artifacts");

await access(deviceConfig).catch(() => {
  throw new Error("Pair this device before installing its startup service: npm run device:pair -- ...");
});
await access(tsxCli);

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
  const target = path.join(os.homedir(), "Library", "LaunchAgents", "vip.posh.autobot-device.plist");
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
  <key>Label</key><string>vip.posh.autobot-device</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodeExecutable)}</string>
    <string>${xml(tsxCli)}</string>
    <string>${xml(agentScript)}</string>
    <string>--config=${xml(deviceConfig)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(projectRoot)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(path.join(logsDirectory, "device-agent.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logsDirectory, "device-agent-error.log"))}</string>
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
  const target = path.join(startupDirectory, "AUTOBOT-Device.vbs");
  const legacyTarget = path.join(startupDirectory, "AUTOBOT-Device.cmd");
  const supportDirectory = path.join(process.env.LOCALAPPDATA ?? appData, "AUTOBOT");
  const watchdog = path.join(supportDirectory, "AUTOBOT-Device-Watchdog.cmd");
  if (remove) {
    await Promise.all([
      rm(target, { force: true }),
      rm(legacyTarget, { force: true }),
      rm(watchdog, { force: true }),
    ]);
    return target;
  }
  await mkdir(startupDirectory, { recursive: true });
  await mkdir(supportDirectory, { recursive: true });
  await rm(legacyTarget, { force: true });
  const script = `@echo off\r\nsetlocal\r\ntitle AUTOBOT Device Bridge\r\n:autobot_restart\r\n"${nodeExecutable}" "${tsxCli}" "${agentScript}" --config="${deviceConfig}"\r\ntimeout /t 5 /nobreak >nul\r\ngoto autobot_restart\r\n`;
  const launcher = `Set shell = CreateObject("WScript.Shell")\r\nshell.Run "cmd.exe /d /c " & Chr(34) & "${watchdog.replaceAll('"', '""')}" & Chr(34), 0, False\r\n`;
  await writeFile(watchdog, script, "utf8");
  await writeFile(target, launcher, "utf8");
  return target;
}

async function installLinux() {
  const target = path.join(os.homedir(), ".config", "autostart", "autobot-device.desktop");
  if (remove) {
    await rm(target, { force: true });
    return target;
  }
  await mkdir(path.dirname(target), { recursive: true });
  const entry = `[Desktop Entry]
Type=Application
Name=AUTOBOT Device Bridge
Comment=Optional local bridge for the AUTOBOT Command Center
Exec=${shellQuote(nodeExecutable)} ${shellQuote(tsxCli)} ${shellQuote(agentScript)} --config=${shellQuote(deviceConfig)}
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
  console.log(`Removed AUTOBOT startup registration: ${target}`);
} else {
  console.log(`Installed AUTOBOT startup registration: ${target}`);
  console.log("The device bridge will start automatically at the next user login.");
  console.log("For this login session, start it now with: npm run device");
}
