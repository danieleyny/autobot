"use client";

import { useCallback, useEffect, useState } from "react";

type Device = {
  id: string;
  name: string;
  version: string;
  mode: "local" | "managed";
  state: Record<string, unknown>;
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

type ControlState = {
  devices: Device[];
  runs: Run[];
  leases: Array<Record<string, unknown>>;
  events: AuditEvent[];
  serverTime: number;
};

const emptyState: ControlState = {
  devices: [],
  runs: [],
  leases: [],
  events: [],
  serverTime: Date.now(),
};

function deviceSummary(device: Device) {
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
  const [pairLabel, setPairLabel] = useState("New device");
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null);
  const [mode, setMode] = useState<"inspection" | "live">("inspection");
  const [eventUrl, setEventUrl] = useState("https://posh.vip/e/test-release");
  const [eventTitle, setEventTitle] = useState("AUTOBOT Classroom Test Drop");
  const [releaseAt, setReleaseAt] = useState("");
  const [ticketStrategy, setTicketStrategy] = useState<"any" | "first" | "second">("any");
  const [organizerOwned, setOrganizerOwned] = useState(false);
  const [permissionConfirmed, setPermissionConfirmed] = useState(false);
  const [liveConfirmation, setLiveConfirmation] = useState("");
  const [primaryDeviceId, setPrimaryDeviceId] = useState("");
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

  const activeRun = state.runs.find((run) => ["draft", "armed", "blocked"].includes(run.status));
  const onlineDevices = state.devices.filter((device) => device.online);
  const activeLease = state.leases.find((lease) => ["offered", "active"].includes(String(lease.status)));

  const resolvedPrimaryDeviceId = selected.includes(primaryDeviceId)
    ? primaryDeviceId
    : selected[0] ?? "";

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
      setPairing({ code: String(result.code), expiresAt: Number(result.expiresAt) });
      setNotice("Pairing code created. It can be used once during the next ten minutes.");
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const launchRun = async () => {
    if (!selected.length) {
      setNotice("Select at least one online device first.");
      return;
    }
    setBusy(true);
    setNotice("");
    try {
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
        primaryDeviceId: resolvedPrimaryDeviceId,
        confirmEventTitle: liveConfirmation,
      });
      setNotice(
        mode === "inspection"
          ? `Inspection sent to ${selected.length} device${selected.length === 1 ? "" : "s"}.`
          : "Live run armed. Only the primary received an execution lease; all other devices are standbys.",
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
    setSelected((current) =>
      current.includes(id) ? current.filter((deviceId) => deviceId !== id) : [...current, id],
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
            <span className="rounded-full bg-[#eef0ec] px-3 py-1.5 text-[#4f5b51]">{selected.length} selected</span>
            <span className="rounded-full bg-[#eef0ec] px-3 py-1.5 text-[#4f5b51]">{activeLease ? "1 live lease" : "No live lease"}</span>
          </div>
        </div>
      </section>

      {notice && (
        <div className="mx-auto max-w-[1500px] px-5 pt-5 lg:px-8">
          <div role="status" className="rounded-xl border border-[#b9c7ac] bg-[#f8ffed] px-4 py-3 text-sm text-[#385020]">{notice}</div>
        </div>
      )}

      <div className="mx-auto grid max-w-[1500px] gap-5 px-5 py-6 lg:grid-cols-[310px_minmax(0,1fr)] lg:px-8">
        <aside className="space-y-4">
          <div className="flex items-end justify-between">
            <div>
              <p className="eyebrow">Fleet</p>
              <h2 className="mt-1 text-xl font-semibold">Devices</h2>
            </div>
            <span className="text-xs font-semibold text-[#69736b]">{loading ? "Loading…" : `${state.devices.length} paired`}</span>
          </div>

          <div className="space-y-3">
            {state.devices.length === 0 && !loading ? (
              <div className="rounded-2xl border border-dashed border-[#b8c0b5] bg-white p-5 text-sm leading-6 text-[#657066]">
                No devices are paired yet. Create a one-time code below, then run the device bridge on that computer.
              </div>
            ) : (
              state.devices.map((device) => (
                <button
                  key={device.id}
                  type="button"
                  onClick={() => device.online && toggleDevice(device.id)}
                  className={`w-full rounded-2xl border bg-white p-4 text-left shadow-[0_1px_1px_rgb(23_32_24/3%)] transition ${
                    selected.includes(device.id)
                      ? "border-[#8bae62] ring-2 ring-[#b8ff5a]/35"
                      : "border-[#d7dcd3]"
                  } ${device.online ? "" : "opacity-60"}`}
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
                </button>
              ))
            )}
          </div>

          <div className="rounded-2xl border border-[#d7dcd3] bg-white p-4">
            <p className="text-sm font-semibold">Pair another device</p>
            <label className="field mt-3">
              <span>Device label</span>
              <input value={pairLabel} onChange={(event) => setPairLabel(event.target.value)} />
            </label>
            <button disabled={busy} onClick={createPairing} className="mt-3 w-full rounded-full bg-[#172018] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">Create pairing code</button>
            {pairing && (
              <div className="mt-3 rounded-xl bg-[#172018] p-3 text-center text-white">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#aeb8af]">One-time code</p>
                <p className="mt-1 font-mono text-2xl font-black tracking-[0.18em] text-[#b8ff5a]">{pairing.code}</p>
                <p className="mt-1 text-[10px] text-[#aeb8af]">Expires {new Date(pairing.expiresAt).toLocaleTimeString()}</p>
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
                    Inspection can run everywhere. Live mode issues a single lease to the primary and leaves every other selected device on standby.
                  </p>
                </div>
                <div className="flex rounded-full border border-[#cbd2c7] bg-[#f3f5ef] p-1 text-xs font-bold">
                  <button onClick={() => setMode("inspection")} className={`rounded-full px-3 py-1.5 ${mode === "inspection" ? "bg-white shadow-sm" : "text-[#69736b]"}`}>Inspection</button>
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
                    <label className="field">
                      <span>Primary executor</span>
                      <select value={resolvedPrimaryDeviceId} onChange={(event) => setPrimaryDeviceId(event.target.value)}>
                        <option value="">Select primary</option>
                        {state.devices.filter((device) => selected.includes(device.id)).map((device) => (
                          <option key={device.id} value={device.id}>{device.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
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
                    ? "No quantity or checkout controls are clicked on any device."
                    : "Exactly one primary lease. Standbys receive no submit command. After execution starts, a failure blocks the run for manual review instead of failing over."}
                </p>
              </div>

              <div className="mt-6 flex flex-wrap gap-3">
                <button disabled={busy || Boolean(activeRun)} onClick={launchRun} className={`rounded-full px-5 py-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-40 ${mode === "live" ? "bg-[#b8ff5a] text-[#172018]" : "bg-[#172018] text-white"}`}>
                  {busy ? "Working…" : mode === "live" ? "Arm selected devices" : "Run inspection"}
                </button>
                <button disabled={busy || !activeRun} onClick={stopAll} className="rounded-full border border-[#cbd2c7] px-5 py-3 text-sm font-bold text-[#4d594f] disabled:opacity-40">Stop active run</button>
              </div>
            </article>

            <article className="rounded-2xl border border-[#d7dcd3] bg-[#172018] p-5 text-white shadow-[0_8px_30px_rgb(23_32_24/10%)] sm:p-6">
              <p className="eyebrow text-[#aeb8af]">Safety state</p>
              <div className="mt-4 grid h-28 w-28 place-items-center rounded-full border border-[#465148] bg-[#202a22] shadow-[inset_0_0_0_8px_rgb(184_255_90/5%)]">
                <div className="text-center">
                  <p className="text-3xl font-semibold text-[#b8ff5a]">{activeLease ? "1" : "0"}</p>
                  <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#aeb8af]">leases</p>
                </div>
              </div>
              <h2 className="mt-5 text-xl font-semibold">{activeLease ? "One primary is authorized" : "Live execution is locked"}</h2>
              <p className="mt-2 text-sm leading-6 text-[#b8c0b8]">
                {activeLease
                  ? "Standby devices remain blocked. A submission or stop closes this run across the fleet."
                  : "No device has central permission to submit. Local device controls remain independent."}
              </p>
              <button disabled={!activeRun || busy} onClick={stopAll} className="mt-6 w-full rounded-full border border-[#515d53] px-4 py-2.5 text-sm font-bold text-[#d8ddd8] disabled:opacity-40">Emergency stop all</button>
            </article>
          </div>

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
