"use client";

import { useCallback, useEffect, useState } from "react";

type Device = {
  id: string;
  name: string;
  version: string;
  mode: "local" | "managed";
  approvalStatus: "pending" | "approved";
  state: Record<string, unknown>;
  encryptionPublicKey: string | null;
  encryptionReady: boolean;
  lastSeenAt: number | null;
  online: boolean;
};

type Run = {
  id: string;
  title: string;
  eventUrl: string;
  eventTitle: string;
  releaseAt: number;
  ticketStrategy: "any" | "first" | "second";
  mode: "inspection" | "live";
  status: string;
  organizerOwned: boolean;
  permissionConfirmed: boolean;
  updatedAt: number;
};

type AuditEvent = {
  id: string;
  run_id?: string | null;
  device_id?: string | null;
  source: string;
  action: string;
  detail: Record<string, unknown>;
  created_at: number;
};

type RunDevice = {
  run_id: string;
  device_id: string;
  device_name: string;
  role: "executor" | "inspection";
  status: string;
  updated_at: number;
};

type ControlState = {
  devices: Device[];
  runs: Run[];
  leases: Array<Record<string, unknown>>;
  runDevices: RunDevice[];
  events: AuditEvent[];
  serverTime: number;
};

const emptyState: ControlState = {
  devices: [],
  runs: [],
  leases: [],
  runDevices: [],
  events: [],
  serverTime: Date.now(),
};

const EVENT_PROFILE_KEY = "autobot:event-profile:v1";
const CURRENT_RELEASE_URL = "https://github.com/danieleyny/autobot/releases/latest";

function supportsFleetExecution(version: string) {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (!match) return false;
  return Number(match[1]) > 0 || Number(match[2]) >= 10;
}

function sameEventPage(left: unknown, right: string) {
  if (typeof left !== "string") return false;
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.hostname === rightUrl.hostname && leftUrl.pathname === rightUrl.pathname;
  } catch {
    return false;
  }
}

function readinessIssue(device: Device, eventUrl: string, eventTitle: string) {
  if (device.approvalStatus !== "approved") return "Waiting for approval";
  if (!device.online) return "Offline";
  if (device.mode !== "managed" || device.state.controlConnected !== true) return "Controller disabled";
  if (!supportsFleetExecution(device.version)) return "Update to v0.10.0";
  if (!device.encryptionReady) return "Password security not ready";
  if (device.state.pageReady !== true) return "Open the event page";
  if (!sameEventPage(device.state.eventUrl, eventUrl)) return "Wrong event page";
  if (
    typeof device.state.eventTitle !== "string" ||
    device.state.eventTitle.replace(/\s+/g, " ").trim().toLocaleLowerCase() !==
      eventTitle.replace(/\s+/g, " ").trim().toLocaleLowerCase()
  ) {
    return "Wrong event title";
  }
  return null;
}

async function encryptEventPassword(password: string, publicKeyPem: string): Promise<string> {
  const encodedKey = publicKeyPem
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s/g, "");
  const keyBytes = Uint8Array.from(atob(encodedKey), (character) => character.charCodeAt(0));
  const publicKey = await crypto.subtle.importKey(
    "spki",
    keyBytes,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const encodedPassword = new TextEncoder().encode(password);
  if (encodedPassword.byteLength > 190) {
    throw new Error("The event password is too long for secure device delivery.");
  }
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, encodedPassword),
  );
  return btoa(String.fromCharCode(...encrypted))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function deviceSummary(device: Device) {
  if (device.approvalStatus !== "approved") return "Approval needed";
  const pageReady = device.state.pageReady === true;
  const armed = device.state.armed === true;
  if (!device.online) return "Offline";
  if (armed) return "Armed";
  if (pageReady) return "Event ready";
  return "Bridge online";
}

export function CommandCenter({ operatorName }: { operatorName: string }) {
  const [state, setState] = useState<ControlState>(emptyState);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [pairLabel, setPairLabel] = useState("Classroom fleet");
  const [enrollmentMax, setEnrollmentMax] = useState(20);
  const [pairing, setPairing] = useState<{
    code: string;
    expiresAt: number;
    kind: "enrollment" | "single";
    maxDevices: number;
  } | null>(null);
  const [mode, setMode] = useState<"inspection" | "live">("inspection");
  const [eventUrl, setEventUrl] = useState("https://posh.vip/e/test-release");
  const [eventTitle, setEventTitle] = useState("AUTOBOT Classroom Test Drop");
  const [eventPassword, setEventPassword] = useState("");
  const [releaseAt, setReleaseAt] = useState("");
  const [ticketStrategy, setTicketStrategy] = useState<"any" | "first" | "second">("any");
  const [organizerOwned, setOrganizerOwned] = useState(false);
  const [permissionConfirmed, setPermissionConfirmed] = useState(false);
  const [liveConfirmation, setLiveConfirmation] = useState("");
  const [clockOffsetMs, setClockOffsetMs] = useState(0);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/control", { cache: "no-store" });
    if (response.status === 401) {
      window.location.assign("/login");
      return;
    }
    if (!response.ok) throw new Error("The controller state could not be loaded.");
    const next = (await response.json()) as ControlState;
    setClockOffsetMs(Date.now() - next.serverTime);
    setState(next);
    setSelected((current) => current.filter((id) => next.devices.some((device) => device.id === id && device.online)));
    setLoading(false);
  }, []);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => {
      refresh().catch((error) => {
        setNotice(error instanceof Error ? error.message : String(error));
        setLoading(false);
      });
    }, 0);
    const timer = window.setInterval(() => refresh().catch(() => {}), 2_000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = JSON.parse(window.localStorage.getItem(EVENT_PROFILE_KEY) || "null") as {
          eventUrl?: string;
          eventTitle?: string;
          ticketStrategy?: "any" | "first" | "second";
        } | null;
        if (saved?.eventUrl) setEventUrl(saved.eventUrl);
        if (saved?.eventTitle) setEventTitle(saved.eventTitle);
        if (saved?.ticketStrategy) setTicketStrategy(saved.ticketStrategy);
      } catch {
        // Ignore invalid device-local preferences.
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const activeRun = state.runs.find((run) => ["draft", "armed", "blocked"].includes(run.status));
  const latestRun = activeRun ?? state.runs[0];
  const onlineDevices = state.devices.filter((device) => device.online);
  const pendingDevices = state.devices.filter((device) => device.approvalStatus === "pending");
  const outdatedDevices = state.devices.filter((device) => !supportsFleetExecution(device.version));
  const activeLeases = state.leases.filter((lease) => ["offered", "active"].includes(String(lease.status)));
  const selectedIdSet = new Set(selected);
  const selectedDevices = state.devices.filter((device) => selectedIdSet.has(device.id));
  const readySelectedDevices = selectedDevices.filter((device) => !readinessIssue(device, eventUrl, eventTitle));
  const latestRunDevices = latestRun
    ? state.runDevices.filter((device) => device.run_id === latestRun.id)
    : [];
  const latestRunStatusByDevice = new Map(
    latestRunDevices.map((device) => [device.device_id, device.status]),
  );

  const post = async (payload: Record<string, unknown>) => {
    const response = await fetch("/api/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (response.status === 401) {
      window.location.assign("/login");
      throw new Error("Your dashboard session expired.");
    }
    const result = (await response.json()) as { error?: string; [key: string]: unknown };
    if (!response.ok) throw new Error(result.error || "The controller rejected the request.");
    return result;
  };

  const createPairing = async () => {
    setBusy(true);
    setNotice("");
    try {
      const result = await post({ action: "create-pairing", label: pairLabel });
      setPairing({
        code: String(result.code),
        expiresAt: Number(result.expiresAt),
        kind: "single",
        maxDevices: 1,
      });
      setNotice("Pairing code created. It can be used once during the next ten minutes.");
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const createEnrollment = async () => {
    setBusy(true);
    setNotice("");
    try {
      const result = await post({
        action: "create-enrollment",
        label: pairLabel,
        maxDevices: enrollmentMax,
      });
      setPairing({
        code: String(result.code),
        expiresAt: Number(result.expiresAt),
        kind: "enrollment",
        maxDevices: Number(result.maxDevices),
      });
      setNotice("Two-hour enrollment started. Approve each laptop after it appears below.");
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const approveDevice = async (device: Device) => {
    setBusy(true);
    setNotice("");
    try {
      await post({ action: "approve-device", deviceId: device.id });
      setNotice(`${device.name} is approved for fleet control.`);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const copySetupCommand = async () => {
    if (!pairing) return;
    const command = `npm run device:pair -- --controller=${window.location.origin} --code=${pairing.code} --name="Laptop 01"`;
    try {
      await navigator.clipboard.writeText(command);
      setNotice("Setup command copied. Change Laptop 01 to that computer's label before running it.");
    } catch {
      setNotice(command);
    }
  };

  const removeDevice = async (device: Device) => {
    if (!window.confirm(`Remove ${device.name} from this controller? Its saved pairing will stop working.`)) return;
    setBusy(true);
    setNotice("");
    try {
      await post({ action: "remove-device", deviceId: device.id });
      setSelected((current) => current.filter((id) => id !== device.id));
      setNotice(`${device.name} was removed. Delete AUTOBOT from that computer before returning it.`);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const useOpenEvent = () => {
    const candidates = selectedDevices
      .map((device) => ({
        url: typeof device.state.eventUrl === "string" ? device.state.eventUrl : "",
        title: typeof device.state.eventTitle === "string" ? device.state.eventTitle : "",
      }))
      .filter((event) => event.url);
    if (!candidates.length) {
      setNotice("Select an online device with the POSH event page open first.");
      return;
    }
    if (candidates.some((event) => !sameEventPage(event.url, candidates[0]!.url))) {
      setNotice("The selected devices are not all on the same event page.");
      return;
    }
    setEventUrl(candidates[0]!.url);
    if (candidates[0]!.title) setEventTitle(candidates[0]!.title);
    setNotice(`Captured the open event from ${candidates.length} selected device${candidates.length === 1 ? "" : "s"}.`);
  };

  const saveEventDetails = () => {
    try {
      window.localStorage.setItem(EVENT_PROFILE_KEY, JSON.stringify({ eventUrl, eventTitle, ticketStrategy }));
      setNotice("Event details saved in this dashboard browser. Password and release time were not saved.");
    } catch {
      setNotice("This browser blocked local event-detail storage. The current form still works for this session.");
    }
  };

  const launchRun = async () => {
    if (!selected.length) {
      setNotice("Select at least one online device first.");
      return;
    }
    if (selected.length > 20) {
      setNotice("Select no more than 20 devices for this classroom fleet test.");
      return;
    }
    if (mode === "live" && !releaseAt) {
      setNotice("Set the live release time before activating the fleet.");
      return;
    }
    if (mode === "live" && readySelectedDevices.length !== selectedDevices.length) {
      const notReady = selectedDevices
        .filter((device) => readinessIssue(device, eventUrl, eventTitle))
        .map((device) => `${device.name}: ${readinessIssue(device, eventUrl, eventTitle)}`)
        .join("; ");
      setNotice(`Fleet preflight is incomplete. ${notReady}`);
      return;
    }
    if (eventPassword && selectedDevices.some((device) => !device.encryptionPublicKey)) {
      setNotice("Every selected device must show Password ready. Update and restart the bridge on any device that needs the security update.");
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      const encryptedSecrets = eventPassword
        ? Object.fromEntries(
            await Promise.all(
              selectedDevices.map(async (device) => [
                device.id,
                await encryptEventPassword(eventPassword, device.encryptionPublicKey!),
              ]),
            ),
          )
        : {};
      const created = await post({
        action: "create-run",
        title: eventTitle,
        eventUrl,
        eventTitle,
        releaseAt: releaseAt ? new Date(releaseAt).getTime() : Date.now(),
        ticketStrategy,
        mode,
        organizerOwned,
        permissionConfirmed,
      });
      await post({
        action: "arm-run",
        runId: created.id,
        deviceIds: selected,
        confirmEventTitle: liveConfirmation,
        encryptedSecrets,
      });
      setEventPassword("");
      setNotice(
        mode === "inspection"
          ? `Rehearsal sent to ${selected.length} device${selected.length === 1 ? "" : "s"}. No RSVP controls will be clicked.`
          : `Fleet activated. ${selected.length} device${selected.length === 1 ? " has" : "s have"} one independent execution lease each.`,
      );
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const stopAll = async () => {
    if (!activeRun) {
      setNotice("There is no active run to stop.");
      return;
    }
    setBusy(true);
    try {
      await post({ action: "stop-run", runId: activeRun.id });
      setNotice("Stop commands queued for every device in the run.");
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const toggleDevice = (id: string) => {
    if (!selected.includes(id) && selected.length >= 20) {
      setNotice("The classroom fleet is capped at 20 selected devices.");
      return;
    }
    setSelected((current) =>
      current.includes(id) ? current.filter((deviceId) => deviceId !== id) : [...current, id],
    );
  };

  const selectOnlineDevices = () => {
    const next = onlineDevices
      .filter((device) => device.approvalStatus === "approved")
      .slice(0, 20)
      .map((device) => device.id);
    setSelected(next);
    setNotice(
      next.length
        ? `Selected ${next.length} online device${next.length === 1 ? "" : "s"}.`
        : "No devices are online yet.",
    );
  };

  const selectReadyDevices = () => {
    const next = state.devices
      .filter((device) => !readinessIssue(device, eventUrl, eventTitle))
      .slice(0, 20)
      .map((device) => device.id);
    setSelected(next);
    setNotice(
      next.length
        ? `Selected ${next.length} fully ready device${next.length === 1 ? "" : "s"}.`
        : "No devices currently pass every readiness check.",
    );
  };

  const relativeClock =
    Math.abs(clockOffsetMs) < 1_000 ? "Clock aligned" : `${Math.round(clockOffsetMs)}ms browser offset`;

  return (
    <main className="min-h-screen bg-[#f3f5ef] text-[#172018]">
      <header className="border-b border-[#cfd5ca] bg-[#172018] text-[#f7f9f2]">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between px-5 py-4 lg:px-8">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-[#b8ff5a] font-mono text-sm font-black text-[#172018]">AB</span>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#aab4a9]">Owned-event test system</p>
              <h1 className="text-lg font-semibold tracking-tight">AUTOBOT Command Center</h1>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span className="hidden text-[#aab4a9] sm:block">{relativeClock}</span>
            <span className="h-2.5 w-2.5 rounded-full bg-[#b8ff5a] shadow-[0_0_0_4px_rgb(184_255_90/12%)]" />
            <span className="hidden max-w-40 truncate rounded-full border border-[#475149] px-3 py-1.5 font-semibold sm:block">{operatorName}</span>
            <form action="/api/auth/logout" method="post">
              <button className="rounded-full border border-[#475149] px-3 py-1.5 font-semibold text-[#dce3dc] transition hover:border-[#718074] hover:text-white" type="submit">
                Lock
              </button>
            </form>
          </div>
        </div>
      </header>

      <section className="border-b border-[#cfd5ca] bg-white">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-4 px-5 py-4 lg:px-8">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#69736b]">Control state</p>
            <p className="mt-0.5 font-semibold">{activeRun ? `${activeRun.title} · ${activeRun.status}` : "No active run"}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
            <span className="rounded-full bg-[#eaf4d9] px-3 py-1.5 text-[#35511e]">{onlineDevices.length} online</span>
            {pendingDevices.length > 0 ? (
              <span className="rounded-full bg-[#fff0d9] px-3 py-1.5 text-[#79501f]">{pendingDevices.length} awaiting approval</span>
            ) : null}
            <span className="rounded-full bg-[#eef0ec] px-3 py-1.5 text-[#4f5b51]">{selected.length} selected</span>
            <span className="rounded-full bg-[#eef0ec] px-3 py-1.5 text-[#4f5b51]">{readySelectedDevices.length}/{selected.length} ready</span>
            <span className="rounded-full bg-[#eef0ec] px-3 py-1.5 text-[#4f5b51]">{activeLeases.length ? `${activeLeases.length} live lease${activeLeases.length === 1 ? "" : "s"}` : "No live leases"}</span>
          </div>
        </div>
      </section>

      {notice && (
        <div className="mx-auto max-w-[1500px] px-5 pt-5 lg:px-8">
          <div role="status" className="rounded-xl border border-[#b9c7ac] bg-[#f8ffed] px-4 py-3 text-sm text-[#385020]">{notice}</div>
        </div>
      )}

      {outdatedDevices.length > 0 ? (
        <div className="mx-auto max-w-[1500px] px-5 pt-5 lg:px-8">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#e3c6a5] bg-[#fff9f1] px-4 py-3 text-sm text-[#6f4a20]">
            <span>{outdatedDevices.length} laptop{outdatedDevices.length === 1 ? " needs" : "s need"} the v0.10.0 update before a live fleet run.</span>
            <a href={CURRENT_RELEASE_URL} target="_blank" rel="noreferrer" className="rounded-full bg-[#172018] px-3 py-1.5 text-xs font-bold text-white">Download current release</a>
          </div>
        </div>
      ) : null}

      <div className="mx-auto grid max-w-[1500px] gap-5 px-5 py-6 lg:grid-cols-[310px_minmax(0,1fr)] lg:px-8">
        <aside className="space-y-4">
          <div className="flex items-end justify-between">
            <div>
              <p className="eyebrow">Fleet</p>
              <h2 className="mt-1 text-xl font-semibold">Devices</h2>
            </div>
            <span className="text-xs font-semibold text-[#69736b]">{loading ? "Loading…" : `${state.devices.length} paired`}</span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={selectReadyDevices}
              className="rounded-full bg-[#172018] px-3 py-2 text-xs font-bold text-white"
            >
              Select ready
            </button>
            <button
              type="button"
              onClick={selectOnlineDevices}
              className="rounded-full border border-[#cbd2c7] bg-white px-3 py-2 text-xs font-bold text-[#4d594f]"
            >
              Select online
            </button>
            <button
              type="button"
              onClick={() => setSelected([])}
              className="col-span-2 rounded-full border border-[#cbd2c7] bg-white px-3 py-2 text-xs font-bold text-[#4d594f]"
            >
              Clear
            </button>
          </div>

          <div className="space-y-3">
            {state.devices.length === 0 && !loading ? (
              <div className="rounded-2xl border border-dashed border-[#b8c0b5] bg-white p-5 text-sm leading-6 text-[#657066]">
                No devices are paired yet. Create a one-time code below, then run the device bridge on that computer.
              </div>
            ) : (
              state.devices.map((device) => {
                const issue = readinessIssue(device, eventUrl, eventTitle);
                return (
                  <div
                    key={device.id}
                    className={`overflow-hidden rounded-2xl border bg-white shadow-[0_1px_1px_rgb(23_32_24/3%)] transition ${
                      selectedIdSet.has(device.id)
                        ? "border-[#8bae62] ring-2 ring-[#b8ff5a]/35"
                        : "border-[#d7dcd3]"
                    } ${device.online ? "" : "opacity-60"}`}
                  >
                    <button
                      type="button"
                      onClick={() => device.online && device.approvalStatus === "approved" && toggleDevice(device.id)}
                      className="w-full p-4 text-left"
                      aria-pressed={selectedIdSet.has(device.id)}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex gap-3">
                          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#edf0e9] font-mono text-xs font-black text-[#4a554c]">
                            {device.name.split(" ").map((part) => part[0]).join("").slice(0, 3)}
                          </span>
                          <div>
                            <h3 className="font-semibold">{device.name}</h3>
                            <p className="mt-0.5 text-xs text-[#6b746c]">{device.mode === "managed" ? "Controller connected" : "Standalone/local"}</p>
                          </div>
                        </div>
                        <span className={`device-dot ${device.online ? "ready" : "local"}`} />
                      </div>
                      <div className="mt-4 flex items-center justify-between border-t border-[#edf0e9] pt-3 text-xs">
                        <span className="font-mono text-[#6b746c]">{device.version}</span>
                        <span className="font-semibold text-[#3e493f]">{deviceSummary(device)}</span>
                      </div>
                      <p className={`mt-2 text-[11px] font-semibold ${issue ? "text-[#9b5f24]" : "text-[#4d6a31]"}`}>
                        {issue || "Ready for fleet test"}
                      </p>
                    </button>
                    <div className="flex border-t border-[#edf0e9]">
                      {device.approvalStatus === "pending" ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => approveDevice(device)}
                          className="flex-1 px-4 py-2 text-left text-[11px] font-bold text-[#35511e] hover:bg-[#f8ffed] disabled:opacity-40"
                        >
                          Approve device
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => removeDevice(device)}
                        className="flex-1 px-4 py-2 text-left text-[11px] font-semibold text-[#7c5248] hover:bg-[#fff7f4] disabled:opacity-40"
                      >
                        Remove and revoke
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="rounded-2xl border border-[#d7dcd3] bg-white p-4">
            <p className="text-sm font-semibold">Enroll laptops</p>
            <p className="mt-1 text-xs leading-5 text-[#6b746c]">One two-hour code can enroll the whole classroom fleet. Every new laptop still requires approval here.</p>
            <label className="field mt-3">
              <span>Enrollment label</span>
              <input value={pairLabel} onChange={(event) => setPairLabel(event.target.value)} />
            </label>
            <label className="field mt-3">
              <span>Maximum laptops</span>
              <input
                type="number"
                min={1}
                max={20}
                value={enrollmentMax}
                onChange={(event) => setEnrollmentMax(Math.min(20, Math.max(1, Number(event.target.value) || 1)))}
              />
            </label>
            <button disabled={busy} onClick={createEnrollment} className="mt-3 w-full rounded-full bg-[#172018] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">Start 2-hour enrollment</button>
            <button disabled={busy} onClick={createPairing} className="mt-2 w-full rounded-full border border-[#cbd2c7] px-4 py-2 text-xs font-bold text-[#4d594f] disabled:opacity-50">Create one-time code instead</button>
            {pairing && (
              <div className="mt-3 rounded-xl bg-[#172018] p-3 text-center text-white">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#aeb8af]">{pairing.kind === "enrollment" ? `Enrollment code · up to ${pairing.maxDevices}` : "One-time code"}</p>
                <p className="mt-1 font-mono text-2xl font-black tracking-[0.18em] text-[#b8ff5a]">{pairing.code}</p>
                <p className="mt-1 text-[10px] text-[#aeb8af]">Expires {new Date(pairing.expiresAt).toLocaleTimeString()}</p>
                <button type="button" onClick={copySetupCommand} className="mt-3 rounded-full border border-[#515d53] px-3 py-1.5 text-[11px] font-bold text-white">Copy setup command</button>
              </div>
            )}
          </div>

          <p className="rounded-xl border border-dashed border-[#b8c0b5] p-3 text-xs leading-5 text-[#657066]">
            Every computer keeps its local Run / Arm controls. Pairing adds remote coordination; it does not remove standalone operation or clear local completion locks.
          </p>
        </aside>

        <section className="space-y-5">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(300px,.65fr)]">
            <article className="rounded-2xl border border-[#d7dcd3] bg-white p-5 shadow-[0_8px_30px_rgb(23_32_24/4%)] sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="eyebrow">Run configuration</p>
                  <h2 className="mt-1 text-2xl font-semibold tracking-tight">Prepare the fleet</h2>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-[#69736b]">
                    Select any number from 1–20. In live mode, every selected laptop receives one independent, one-use execution lease.
                  </p>
                </div>
                <div className="flex rounded-full border border-[#cbd2c7] bg-[#f3f5ef] p-1 text-xs font-bold">
                  <button onClick={() => setMode("inspection")} className={`rounded-full px-3 py-1.5 ${mode === "inspection" ? "bg-white shadow-sm" : "text-[#69736b]"}`}>Rehearsal</button>
                  <button onClick={() => setMode("live")} className={`rounded-full px-3 py-1.5 ${mode === "live" ? "bg-[#172018] text-white" : "text-[#69736b]"}`}>Live test</button>
                </div>
              </div>

              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <label className="field sm:col-span-2">
                  <span>Organizer-owned POSH event URL</span>
                  <input value={eventUrl} onChange={(event) => setEventUrl(event.target.value)} />
                </label>
                <label className="field sm:col-span-2">
                  <span>Exact event title</span>
                  <input value={eventTitle} onChange={(event) => setEventTitle(event.target.value)} />
                </label>
                <div className="flex flex-wrap gap-2 sm:col-span-2">
                  <button
                    type="button"
                    onClick={useOpenEvent}
                    className="rounded-full border border-[#cbd2c7] px-4 py-2 text-xs font-bold text-[#4d594f]"
                  >
                    Use event open on selected devices
                  </button>
                  <button
                    type="button"
                    onClick={saveEventDetails}
                    className="rounded-full border border-[#cbd2c7] px-4 py-2 text-xs font-bold text-[#4d594f]"
                  >
                    Save event details
                  </button>
                </div>
                <label className="field sm:col-span-2">
                  <span>Event password (optional)</span>
                  <input
                    type="password"
                    autoComplete="off"
                    maxLength={160}
                    value={eventPassword}
                    onChange={(event) => setEventPassword(event.target.value)}
                    placeholder="Sent securely to every selected device"
                  />
                  <small className="font-normal leading-5 text-[#6b746c]">
                    Encrypted separately for each device. The controller never receives a readable copy.
                  </small>
                </label>
                <label className="field">
                  <span>Release time</span>
                  <input type="datetime-local" value={releaseAt} onChange={(event) => setReleaseAt(event.target.value)} />
                </label>
                <label className="field">
                  <span>Ticket strategy</span>
                  <select value={ticketStrategy} onChange={(event) => setTicketStrategy(event.target.value as typeof ticketStrategy)}>
                    <option value="any">Any available free RSVP</option>
                    <option value="first">First available free RSVP</option>
                    <option value="second">Second available free RSVP</option>
                  </select>
                </label>
                {mode === "live" && (
                  <>
                    <label className="field sm:col-span-2">
                      <span>Type the exact event title to confirm</span>
                      <input value={liveConfirmation} onChange={(event) => setLiveConfirmation(event.target.value)} />
                    </label>
                    <label className="check-card">
                      <input type="checkbox" checked={organizerOwned} onChange={(event) => setOrganizerOwned(event.target.checked)} />
                      <span>This private test event is organizer-owned.</span>
                    </label>
                    <label className="check-card">
                      <input type="checkbox" checked={permissionConfirmed} onChange={(event) => setPermissionConfirmed(event.target.checked)} />
                      <span>Written permission for this controlled test is recorded.</span>
                    </label>
                  </>
                )}
              </div>

              <div className="mt-5 rounded-xl border border-[#e0e5dc] bg-[#f7f9f4] p-4">
                <p className="text-sm font-semibold">Execution policy</p>
                <p className="mt-1 text-xs leading-5 text-[#6b746c]">
                  {mode === "inspection"
                    ? "Rehearsal checks every selected laptop without changing ticket quantity or submitting checkout."
                    : `${selected.length || "No"} selected device${selected.length === 1 ? "" : "s"} = ${selected.length || "no"} planned reservation${selected.length === 1 ? "" : "s"}. Each account can submit at most once; no device receives a replacement lease.`}
                </p>
              </div>

              {mode === "live" && selected.length > 0 && (
                <div className={`mt-3 rounded-xl border p-4 ${readySelectedDevices.length === selected.length ? "border-[#b9c7ac] bg-[#f8ffed]" : "border-[#e3c6a5] bg-[#fff9f1]"}`}>
                  <p className="text-sm font-semibold">Fleet preflight: {readySelectedDevices.length}/{selected.length} ready</p>
                  <p className="mt-1 text-xs leading-5 text-[#6b746c]">
                    {readySelectedDevices.length === selected.length
                      ? "Every selected device is online, updated, controller-enabled, password-ready, and on the configured event page."
                      : "Open the event page and resolve the readiness message shown on each selected device card before activation."}
                  </p>
                </div>
              )}

              <div className="mt-6 flex flex-wrap gap-3">
                <button disabled={busy || Boolean(activeRun) || selected.length === 0} onClick={launchRun} className={`rounded-full px-5 py-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-40 ${mode === "live" ? "bg-[#b8ff5a] text-[#172018]" : "bg-[#172018] text-white"}`}>
                  {busy ? "Working…" : mode === "live" ? `Activate ${selected.length || "selected"} device${selected.length === 1 ? "" : "s"}` : "Run fleet rehearsal"}
                </button>
                <button disabled={busy || !activeRun} onClick={stopAll} className="rounded-full border border-[#cbd2c7] px-5 py-3 text-sm font-bold text-[#4d594f] disabled:opacity-40">Stop active run</button>
              </div>
            </article>

            <article className="rounded-2xl border border-[#d7dcd3] bg-[#172018] p-5 text-white shadow-[0_8px_30px_rgb(23_32_24/10%)] sm:p-6">
              <p className="eyebrow text-[#aeb8af]">Safety state</p>
              <div className="mt-4 grid h-28 w-28 place-items-center rounded-full border border-[#465148] bg-[#202a22] shadow-[inset_0_0_0_8px_rgb(184_255_90/5%)]">
                <div className="text-center">
                  <p className="text-3xl font-semibold text-[#b8ff5a]">{activeLeases.length}</p>
                  <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#aeb8af]">leases</p>
                </div>
              </div>
              <h2 className="mt-5 text-xl font-semibold">{activeLeases.length ? `${activeLeases.length} device${activeLeases.length === 1 ? " is" : "s are"} authorized` : "Live execution is locked"}</h2>
              <p className="mt-2 text-sm leading-6 text-[#b8c0b8]">
                {activeLeases.length
                  ? "Each active lease belongs to one selected laptop and permits no more than one reservation from that device."
                  : "No device has central permission to submit. Local device controls remain independent."}
              </p>
              <button disabled={!activeRun || busy} onClick={stopAll} className="mt-6 w-full rounded-full border border-[#515d53] px-4 py-2.5 text-sm font-bold text-[#d8ddd8] disabled:opacity-40">Emergency stop all</button>
            </article>
          </div>

          <article className="rounded-2xl border border-[#d7dcd3] bg-white p-5 sm:p-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="eyebrow">Fleet overview</p>
                <h2 className="mt-1 text-xl font-semibold">Readiness and results</h2>
              </div>
              <span className="text-xs font-semibold text-[#69736b]">
                {latestRun ? `${latestRun.eventTitle} · ${latestRun.status}` : "No run history yet"}
              </span>
            </div>
            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[820px] border-collapse text-left text-sm">
                <thead className="text-[11px] uppercase tracking-[0.12em] text-[#7b847c]">
                  <tr className="border-b border-[#dfe4dc]">
                    <th className="pb-3 font-bold">Laptop</th>
                    <th className="pb-3 font-bold">Connection</th>
                    <th className="pb-3 font-bold">Preflight</th>
                    <th className="pb-3 font-bold">Latest run</th>
                    <th className="pb-3 font-bold">Last check-in</th>
                  </tr>
                </thead>
                <tbody>
                  {state.devices.length === 0 ? (
                    <tr><td colSpan={5} className="py-8 text-center text-[#7b847c]">Enrolled laptops will appear here.</td></tr>
                  ) : (
                    state.devices.map((device) => {
                      const issue = readinessIssue(device, eventUrl, eventTitle);
                      const runStatus = latestRunStatusByDevice.get(device.id);
                      return (
                        <tr key={device.id} className="border-b border-[#edf0e9] last:border-0">
                          <td className="py-3 font-semibold">{device.name}<span className="ml-2 font-mono text-[10px] text-[#7b847c]">{device.version}</span></td>
                          <td className="py-3"><span className={device.online ? "text-[#446426]" : "text-[#8b5e52]"}>{device.online ? "Online" : "Offline"}</span></td>
                          <td className={`py-3 font-semibold ${issue ? "text-[#9b5f24]" : "text-[#446426]"}`}>{issue || "Ready"}</td>
                          <td className="py-3 capitalize text-[#59645b]">{runStatus ? runStatus.replaceAll("-", " ") : "Not included"}</td>
                          <td className="py-3 font-mono text-xs text-[#657066]">{device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleTimeString() : "Never"}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </article>

          <article className="rounded-2xl border border-[#d7dcd3] bg-white p-5 sm:p-6">
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="eyebrow">Audit stream</p>
                <h2 className="mt-1 text-xl font-semibold">Recent activity</h2>
              </div>
              <span className="text-xs font-semibold text-[#69736b]">Newest first</span>
            </div>
            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[620px] border-collapse text-left text-sm">
                <thead className="text-[11px] uppercase tracking-[0.12em] text-[#7b847c]">
                  <tr className="border-b border-[#dfe4dc]"><th className="pb-3 font-bold">Time</th><th className="pb-3 font-bold">Source</th><th className="pb-3 font-bold">Event</th></tr>
                </thead>
                <tbody>
                  {state.events.length === 0 ? (
                    <tr><td colSpan={3} className="py-8 text-center text-[#7b847c]">Activity will appear when a device pairs or a run begins.</td></tr>
                  ) : (
                    state.events.map((event) => (
                      <tr key={event.id} className="border-b border-[#edf0e9] last:border-0">
                        <td className="py-3 font-mono text-xs text-[#657066]">{new Date(event.created_at).toLocaleTimeString()}</td>
                        <td className="py-3 font-semibold">{event.source}</td>
                        <td className="py-3 text-[#59645b]">{event.action.replaceAll("-", " ")}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}
