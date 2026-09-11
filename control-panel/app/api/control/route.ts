import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { audit, ensureControlSchema, nowMs, parseJson, randomPairingCode, sha256 } from "../../../db/control";
import { getD1 } from "../../../db";
import { CONTROLLER_REVISION, isDeviceOnline } from "../../../db/device-presence";
import {
  CONTROLLER_OWNER_ID,
  isSameOriginRequest,
  isValidPinSession,
  PIN_SESSION_COOKIE,
} from "../../pin-auth";

type DeviceRow = {
  id: string;
  name: string;
  contact_email: string | null;
  contact_phone: string | null;
  description: string | null;
  version: string;
  mode: "local" | "managed";
  approval_status: "pending" | "approved";
  state_json: string;
  public_key: string | null;
  last_seen_at: number | null;
  created_at: number;
};

type RunRow = {
  id: string;
  title: string;
  event_url: string;
  event_title: string;
  release_at: number;
  ticket_strategy: "any" | "first" | "second";
  mode: "inspection" | "live";
  status: string;
  organizer_owned: number;
  permission_confirmed: number;
  created_at: number;
  updated_at: number;
};

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

async function operator() {
  const store = await cookies();
  return (await isValidPinSession(store.get(PIN_SESSION_COOKIE)?.value))
    ? { displayName: "PIN access", email: "", userId: CONTROLLER_OWNER_ID }
    : null;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function validateEventUrl(value: unknown): string {
  const raw = nonEmpty(value, "Event URL");
  const url = new URL(raw);
  const isOwnedPosh = url.protocol === "https:" && url.hostname === "posh.vip" && url.pathname.startsWith("/e/");
  const isLocalMock = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  if (!isOwnedPosh && !isLocalMock) {
    throw new Error("Event URL must be a posh.vip /e/ page or the local mock event.");
  }
  if (isOwnedPosh) {
    url.search = "";
    url.hash = "";
  }
  return url.toString();
}

function sameEventPage(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.hostname === rightUrl.hostname && leftUrl.pathname === rightUrl.pathname;
  } catch {
    return false;
  }
}

function sameEventTitle(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  return normalize(left) === normalize(right);
}

function versionAtLeast(version: string, required: [number, number, number]): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const current = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let index = 0; index < required.length; index += 1) {
    if (current[index]! > required[index]!) return true;
    if (current[index]! < required[index]!) return false;
  }
  return true;
}

function supportsFleetExecution(version: string): boolean {
  return versionAtLeast(version, [0, 11, 0]);
}

function supportsFastRelease(version: string): boolean {
  return versionAtLeast(version, [0, 12, 2]);
}

function optionalText(value: unknown, label: string, maxLength: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

async function queueCommand(input: {
  ownerId: string;
  deviceId: string;
  runId?: string;
  type: string;
  payload?: Record<string, unknown>;
}) {
  await getD1()
    .prepare(
      `INSERT INTO commands
       (id, owner_id, device_id, run_id, type, payload_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.ownerId,
      input.deviceId,
      input.runId ?? null,
      input.type,
      JSON.stringify(input.payload ?? {}),
      nowMs(),
    )
    .run();
}

export async function GET() {
  const user = await operator();
  if (!user) return jsonError("A valid dashboard PIN session is required.", 401);
  await ensureControlSchema();
  const db = getD1();
  const [deviceResult, runResult, auditResult, leaseResult, runDeviceResult] = await db.batch([
    db.prepare(
      `SELECT id, name, contact_email, contact_phone, description, version, mode,
              approval_status, state_json, public_key, last_seen_at, created_at
       FROM devices WHERE owner_id = ? ORDER BY created_at ASC`,
    ).bind(user.userId),
    db.prepare(
      `SELECT id, title, event_url, event_title, release_at, ticket_strategy, mode, status,
              organizer_owned, permission_confirmed, created_at, updated_at
       FROM runs WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 12`,
    ).bind(user.userId),
    db.prepare(
      `SELECT id, run_id, device_id, source, action, detail_json, created_at
       FROM audit_events WHERE owner_id = ? ORDER BY created_at DESC LIMIT 50`,
    ).bind(user.userId),
    db.prepare(
      `SELECT id, run_id, device_id, status, created_at, activated_at, completed_at
       FROM leases WHERE owner_id = ? ORDER BY created_at DESC LIMIT 100`,
    ).bind(user.userId),
    db.prepare(
      `SELECT run_devices.run_id, run_devices.device_id, run_devices.role,
              run_devices.ticket_strategy, run_devices.status,
              devices.name AS device_name, runs.updated_at
       FROM run_devices
       JOIN devices ON devices.id = run_devices.device_id
       JOIN runs ON runs.id = run_devices.run_id
       WHERE runs.owner_id = ?
       ORDER BY runs.updated_at DESC, devices.name ASC LIMIT 240`,
    ).bind(user.userId),
  ]);

  const presenceCheckedAt = nowMs();
  const devices = (deviceResult.results as unknown as DeviceRow[]).map((device) => {
    const state = parseJson<Record<string, unknown>>(device.state_json, {});
    return {
      id: device.id,
      name: device.name,
      contactEmail: device.contact_email,
      contactPhone: device.contact_phone,
      description: device.description,
      version: device.version,
      mode: device.mode,
      approvalStatus: device.approval_status,
      state,
      encryptionPublicKey: device.public_key,
      encryptionReady: Boolean(device.public_key),
      lastSeenAt: device.last_seen_at,
      online: isDeviceOnline(device.last_seen_at, presenceCheckedAt, state),
      createdAt: device.created_at,
    };
  });
  const runs = (runResult.results as unknown as RunRow[]).map((run) => ({
    id: run.id,
    title: run.title,
    eventUrl: run.event_url,
    eventTitle: run.event_title,
    releaseAt: run.release_at,
    ticketStrategy: run.ticket_strategy,
    mode: run.mode,
    status: run.status,
    organizerOwned: Boolean(run.organizer_owned),
    permissionConfirmed: Boolean(run.permission_confirmed),
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  }));
  const events = (auditResult.results as Array<Record<string, unknown>>).map((event) => ({
    ...event,
    detail: parseJson(String(event.detail_json ?? "{}"), {}),
    detail_json: undefined,
  }));

  return NextResponse.json({
    controllerRevision: CONTROLLER_REVISION,
    user: { displayName: user.displayName, email: user.email },
    devices,
    runs,
    leases: leaseResult.results,
    runDevices: runDeviceResult.results,
    events,
    serverTime: nowMs(),
  });
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return jsonError("The request origin is not allowed.", 403);
  const user = await operator();
  if (!user) return jsonError("A valid dashboard PIN session is required.", 401);
  await ensureControlSchema();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError("A JSON request body is required.");
  }

  try {
    switch (body.action) {
      case "create-pairing": {
        const label = nonEmpty(body.label, "Device label").slice(0, 80);
        const code = randomPairingCode();
        const codeHash = await sha256(code);
        const createdAt = nowMs();
        const expiresAt = createdAt + 10 * 60_000;
        await getD1()
          .prepare(
            `INSERT INTO pairing_codes
             (code_hash, owner_id, label, expires_at, used_at, max_uses, used_count,
              approval_required, created_at)
             VALUES (?, ?, ?, ?, NULL, 1, 0, 0, ?)`,
          )
          .bind(codeHash, user.userId, label, expiresAt, createdAt)
          .run();
        await audit({
          ownerId: user.userId,
          source: "control",
          action: "pairing-code-created",
          detail: { label, expiresAt },
        });
        return NextResponse.json({ code, expiresAt });
      }

      case "create-enrollment": {
        const label = nonEmpty(body.label, "Enrollment label").slice(0, 80);
        const maxUses = Math.min(20, Math.max(1, Math.trunc(Number(body.maxDevices) || 20)));
        const code = randomPairingCode();
        const codeHash = await sha256(code);
        const createdAt = nowMs();
        const expiresAt = createdAt + 48 * 60 * 60_000;
        await getD1()
          .prepare(
            `INSERT INTO pairing_codes
             (code_hash, owner_id, label, expires_at, used_at, max_uses, used_count,
              approval_required, created_at)
             VALUES (?, ?, ?, ?, NULL, ?, 0, 1, ?)`,
          )
          .bind(codeHash, user.userId, label, expiresAt, maxUses, createdAt)
          .run();
        await audit({
          ownerId: user.userId,
          source: "control",
          action: "enrollment-window-created",
          detail: { label, maxUses, expiresAt },
        });
        return NextResponse.json({ code, expiresAt, maxDevices: maxUses });
      }

      case "approve-device": {
        const deviceId = nonEmpty(body.deviceId, "Device ID");
        const approved = await getD1()
          .prepare(
            `UPDATE devices SET approval_status = 'approved'
             WHERE id = ? AND owner_id = ? AND approval_status = 'pending'`,
          )
          .bind(deviceId, user.userId)
          .run();
        if (!approved.meta.changes) throw new Error("Pending device not found.");
        await audit({
          ownerId: user.userId,
          deviceId,
          source: "control",
          action: "device-approved",
        });
        return NextResponse.json({ ok: true });
      }

      case "update-device-profile": {
        const deviceId = nonEmpty(body.deviceId, "Device ID");
        const contactEmail = optionalText(body.contactEmail, "Email", 254);
        const contactPhone = optionalText(body.contactPhone, "Phone", 40);
        const description = optionalText(body.description, "Description", 200);
        if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
          throw new Error("Enter a valid email address or leave it blank.");
        }
        const updated = await getD1()
          .prepare(
            `UPDATE devices SET contact_email = ?, contact_phone = ?, description = ?
             WHERE id = ? AND owner_id = ?`,
          )
          .bind(contactEmail, contactPhone, description, deviceId, user.userId)
          .run();
        if (!updated.meta.changes) throw new Error("Device not found.");
        await audit({
          ownerId: user.userId,
          deviceId,
          source: "control",
          action: "device-profile-updated",
          detail: {
            emailRecorded: Boolean(contactEmail),
            phoneRecorded: Boolean(contactPhone),
            descriptionRecorded: Boolean(description),
          },
        });
        return NextResponse.json({ ok: true });
      }

      case "refresh-profile-host": {
        const deviceId = nonEmpty(body.deviceId, "Device ID");
        const device = await getD1()
          .prepare(
            `SELECT id, name, version, approval_status, last_seen_at, state_json FROM devices
             WHERE id = ? AND owner_id = ? LIMIT 1`,
          )
          .bind(deviceId, user.userId)
          .first<{
            id: string;
            name: string;
            version: string;
            approval_status: string;
            last_seen_at: number | null;
            state_json: string;
          }>();
        if (!device) throw new Error("Profile host worker not found.");
        const state = parseJson<Record<string, unknown>>(device.state_json, {});
        if (device.approval_status !== "approved") throw new Error("Approve this profile host first.");
        if (!versionAtLeast(device.version, [0, 13, 0]) || state.profileMode !== "multi") {
          throw new Error("This command is available only for a v0.13 multi-profile host.");
        }
        if (!isDeviceOnline(device.last_seen_at, nowMs(), state)) {
          throw new Error("The profile-host service is offline. Start it locally before requesting a refresh.");
        }
        const timestamp = nowMs();
        const db = getD1();
        await db.batch([
          db.prepare(
            `UPDATE commands SET status = 'acknowledged', acknowledged_at = ?
             WHERE owner_id = ? AND device_id = ? AND type = 'refresh-host'
               AND status IN ('queued', 'delivered')`,
          ).bind(timestamp, user.userId, deviceId),
          db.prepare(
            `INSERT INTO commands
             (id, owner_id, device_id, run_id, type, payload_json, status, created_at)
             VALUES (?, ?, ?, NULL, 'refresh-host', '{}', 'queued', ?)`,
          ).bind(crypto.randomUUID(), user.userId, deviceId, timestamp),
        ]);
        await audit({
          ownerId: user.userId,
          deviceId,
          source: "control",
          action: "profile-host-refresh-requested",
          detail: { hostId: state.hostId ?? null },
        });
        return NextResponse.json({ ok: true });
      }

      case "launch-workers": {
        const selectedIds = Array.isArray(body.deviceIds)
          ? [...new Set(body.deviceIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
          : [];
        if (!selectedIds.length) throw new Error("Select at least one profile worker.");
        if (selectedIds.length > 20) throw new Error("Launch no more than 20 profile workers at once.");
        const activeRun = await getD1()
          .prepare("SELECT id FROM runs WHERE owner_id = ? AND status IN ('draft', 'armed', 'blocked') LIMIT 1")
          .bind(user.userId)
          .first<{ id: string }>();
        if (activeRun) throw new Error("Stop or finish the active run before launching browser workers.");

        const placeholders = selectedIds.map(() => "?").join(",");
        const selectedDevices = await getD1()
          .prepare(
            `SELECT id, name, version, approval_status, last_seen_at, state_json FROM devices
             WHERE owner_id = ? AND id IN (${placeholders})`,
          )
          .bind(user.userId, ...selectedIds)
          .all<{
            id: string;
            name: string;
            version: string;
            approval_status: string;
            last_seen_at: number | null;
            state_json: string;
          }>();
        if (selectedDevices.results.length !== selectedIds.length) {
          throw new Error("One or more profile workers do not belong to this controller.");
        }
        const timestamp = nowMs();
        for (const device of selectedDevices.results) {
          const state = parseJson<Record<string, unknown>>(device.state_json, {});
          if (device.approval_status !== "approved") {
            throw new Error(`Approve ${device.name} before launching its browser profile.`);
          }
          if (!versionAtLeast(device.version, [0, 13, 0]) || state.profileMode !== "multi") {
            throw new Error(`${device.name} is a classic device, not a multi-profile worker.`);
          }
          if (!isDeviceOnline(device.last_seen_at, timestamp, state)) {
            throw new Error(`${device.name}'s profile-host service is offline.`);
          }
        }

        const db = getD1();
        await db.batch([
          db.prepare(
            `UPDATE commands SET status = 'acknowledged', acknowledged_at = ?
             WHERE owner_id = ? AND device_id IN (${placeholders}) AND type = 'launch-worker'
               AND status IN ('queued', 'delivered')`,
          ).bind(timestamp, user.userId, ...selectedIds),
          ...selectedIds.map((deviceId) =>
            db.prepare(
              `INSERT INTO commands
               (id, owner_id, device_id, run_id, type, payload_json, status, created_at)
               VALUES (?, ?, ?, NULL, 'launch-worker', ?, 'queued', ?)`,
            ).bind(
              crypto.randomUUID(),
              user.userId,
              deviceId,
              JSON.stringify({ startUrl: "https://posh.vip/" }),
              timestamp,
            ),
          ),
        ]);
        await audit({
          ownerId: user.userId,
          source: "control",
          action: "profile-workers-launched",
          detail: { workers: selectedIds.length },
        });
        return NextResponse.json({ ok: true, workers: selectedIds.length });
      }

      case "open-event": {
        const eventUrl = validateEventUrl(body.eventUrl);
        const selectedIds = Array.isArray(body.deviceIds)
          ? [...new Set(body.deviceIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
          : [];
        if (!selectedIds.length) throw new Error("Select at least one online device.");
        if (selectedIds.length > 20) throw new Error("Select no more than 20 devices.");
        const activeRun = await getD1()
          .prepare("SELECT id FROM runs WHERE owner_id = ? AND status IN ('draft', 'armed', 'blocked') LIMIT 1")
          .bind(user.userId)
          .first<{ id: string }>();
        if (activeRun) throw new Error("Stop or finish the active run before opening a different event.");

        const placeholders = selectedIds.map(() => "?").join(",");
        const selectedDevices = await getD1()
          .prepare(
            `SELECT id, name, version, approval_status, last_seen_at, state_json FROM devices
             WHERE owner_id = ? AND id IN (${placeholders})`,
          )
          .bind(user.userId, ...selectedIds)
          .all<{
            id: string;
            name: string;
            version: string;
            approval_status: string;
            last_seen_at: number | null;
            state_json: string;
          }>();
        if (selectedDevices.results.length !== selectedIds.length) {
          throw new Error("One or more selected devices do not belong to this controller.");
        }
        if (selectedDevices.results.some((device) => device.approval_status !== "approved")) {
          throw new Error("Approve every selected device before opening an event.");
        }
        if (
          selectedDevices.results.some((device) =>
            !isDeviceOnline(
              device.last_seen_at,
              nowMs(),
              parseJson<Record<string, unknown>>(device.state_json, {}),
            )
          )
        ) {
          throw new Error("Every selected device must be online before opening an event.");
        }
        const needsUpdate = selectedDevices.results.filter((device) => !supportsFleetExecution(device.version));
        if (needsUpdate.length) {
          throw new Error(`${needsUpdate.map((device) => device.name).join(", ")} must be updated to v0.11.0.`);
        }

        const timestamp = nowMs();
        const db = getD1();
        await db.batch([
          db.prepare(
            `UPDATE commands SET status = 'acknowledged', acknowledged_at = ?
             WHERE owner_id = ? AND device_id IN (${placeholders}) AND type = 'open-event'
               AND status IN ('queued', 'delivered')`,
          ).bind(timestamp, user.userId, ...selectedIds),
          ...selectedIds.map((deviceId) =>
            db.prepare(
              `INSERT INTO commands
               (id, owner_id, device_id, run_id, type, payload_json, status, created_at)
               VALUES (?, ?, ?, NULL, 'open-event', ?, 'queued', ?)`,
            ).bind(crypto.randomUUID(), user.userId, deviceId, JSON.stringify({ eventUrl }), timestamp),
          ),
        ]);
        await audit({
          ownerId: user.userId,
          source: "control",
          action: "event-open-requested",
          detail: { devices: selectedIds.length, eventUrl },
        });
        return NextResponse.json({ ok: true, devices: selectedIds.length });
      }

      case "remove-device": {
        const deviceId = nonEmpty(body.deviceId, "Device ID");
        const device = await getD1()
          .prepare("SELECT id, name FROM devices WHERE id = ? AND owner_id = ? LIMIT 1")
          .bind(deviceId, user.userId)
          .first<{ id: string; name: string }>();
        if (!device) throw new Error("Device not found.");
        const activeLink = await getD1()
          .prepare(
            `SELECT runs.id FROM runs
             JOIN run_devices ON run_devices.run_id = runs.id
             WHERE runs.owner_id = ? AND run_devices.device_id = ?
               AND runs.status IN ('draft', 'armed', 'blocked')
             LIMIT 1`,
          )
          .bind(user.userId, deviceId)
          .first<{ id: string }>();
        if (activeLink) throw new Error("Stop or finish the active run before removing this device.");
        await audit({
          ownerId: user.userId,
          deviceId,
          source: "control",
          action: "device-removed",
          detail: { name: device.name },
        });
        await getD1().batch([
          getD1().prepare("DELETE FROM commands WHERE device_id = ? AND owner_id = ?").bind(deviceId, user.userId),
          getD1().prepare("DELETE FROM leases WHERE device_id = ? AND owner_id = ?").bind(deviceId, user.userId),
          getD1().prepare("DELETE FROM run_devices WHERE device_id = ?").bind(deviceId),
          getD1().prepare("DELETE FROM devices WHERE id = ? AND owner_id = ?").bind(deviceId, user.userId),
        ]);
        return NextResponse.json({ ok: true });
      }

      case "create-run": {
        const mode = body.mode === "live" ? "live" : "inspection";
        const eventTitle = nonEmpty(body.eventTitle, "Exact event title").slice(0, 200);
        const title = nonEmpty(body.title ?? eventTitle, "Run title").slice(0, 200);
        const eventUrl = validateEventUrl(body.eventUrl);
        const releaseAt = Number(body.releaseAt);
        if (!Number.isFinite(releaseAt)) throw new Error("Release time is invalid.");
        const ticketStrategy = ["first", "second"].includes(String(body.ticketStrategy))
          ? String(body.ticketStrategy)
          : "any";
        const organizerOwned = body.organizerOwned === true;
        const permissionConfirmed = body.permissionConfirmed === true;
        if (mode === "live" && releaseAt < nowMs() - 1_000) {
          throw new Error("Live release time must be now or in the future.");
        }
        if (mode === "live" && (!organizerOwned || !permissionConfirmed)) {
          throw new Error("Live mode requires organizer ownership and written test permission confirmation.");
        }
        const id = crypto.randomUUID();
        const timestamp = nowMs();
        await getD1()
          .prepare(
            `INSERT INTO runs
             (id, owner_id, title, event_url, event_title, release_at, ticket_strategy, mode, status,
              organizer_owned, permission_confirmed, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
          )
          .bind(
            id,
            user.userId,
            title,
            eventUrl,
            eventTitle,
            Math.trunc(releaseAt),
            ticketStrategy,
            mode,
            organizerOwned ? 1 : 0,
            permissionConfirmed ? 1 : 0,
            timestamp,
            timestamp,
          )
          .run();
        await audit({
          ownerId: user.userId,
          runId: id,
          source: "control",
          action: "run-created",
          detail: { mode, eventTitle, releaseAt },
        });
        return NextResponse.json({ id });
      }

      case "arm-run": {
        const runId = nonEmpty(body.runId, "Run ID");
        const selectedIds = Array.isArray(body.deviceIds)
          ? [...new Set(body.deviceIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
          : [];
        if (!selectedIds.length) throw new Error("Select at least one online device.");
        if (selectedIds.length > 20) throw new Error("A classroom fleet run supports at most 20 devices.");
        const run = await getD1()
          .prepare(
            `SELECT id, event_url, event_title, release_at, ticket_strategy, mode, status,
                    organizer_owned, permission_confirmed
             FROM runs WHERE id = ? AND owner_id = ? LIMIT 1`,
          )
          .bind(runId, user.userId)
          .first<Record<string, unknown>>();
        if (!run) throw new Error("Run not found.");
        if (run.status !== "draft") throw new Error("Only a draft run can be armed.");

        const placeholders = selectedIds.map(() => "?").join(",");
        const deviceRows = await getD1()
          .prepare(
            `SELECT id, version, approval_status, last_seen_at, state_json, public_key FROM devices
             WHERE owner_id = ? AND id IN (${placeholders})`,
          )
          .bind(user.userId, ...selectedIds)
          .all<{
            id: string;
            version: string;
            approval_status: string;
            last_seen_at: number | null;
            state_json: string;
            public_key: string | null;
          }>();
        if (deviceRows.results.length !== selectedIds.length) throw new Error("One or more devices do not belong to this controller.");
        const deviceStates = deviceRows.results.map((device) => ({
          ...device,
          state: parseJson<Record<string, unknown>>(device.state_json, {}),
        }));
        if (deviceStates.some((device) => device.approval_status !== "approved")) {
          throw new Error("Approve every selected device before arming.");
        }
        if (deviceStates.some((device) => !isDeviceOnline(device.last_seen_at, nowMs(), device.state))) {
          throw new Error("Every selected device must be online before arming.");
        }
        if (deviceStates.some((device) => device.state.controlConnected !== true)) {
          throw new Error("Every selected device must have command-center control enabled locally.");
        }
        if (run.mode === "live" && deviceStates.some((device) => device.state.pageVisible !== true)) {
          throw new Error("Keep the configured POSH event tab visible on every selected device before arming.");
        }
        if (deviceStates.some((device) => !sameEventPage(device.state.eventUrl, run.event_url))) {
          throw new Error("Every selected device must have the configured event page open before arming.");
        }
        if (deviceStates.some((device) => !sameEventTitle(device.state.eventTitle, run.event_title))) {
          throw new Error("Every selected device must show the configured event title before arming.");
        }
        if (run.mode === "live" && deviceStates.some((device) => !supportsFastRelease(device.version))) {
          throw new Error("Every selected device must run AUTOBOT v0.12.2 or newer for prepared live activation.");
        }

        const encryptedSecrets =
          body.encryptedSecrets && typeof body.encryptedSecrets === "object" && !Array.isArray(body.encryptedSecrets)
            ? (body.encryptedSecrets as Record<string, unknown>)
            : {};
        const passwordIncluded = Object.keys(encryptedSecrets).length > 0;
        if (passwordIncluded) {
          for (const device of deviceStates) {
            if (!device.public_key) {
              throw new Error("Every selected device must show Password ready before sending an event password.");
            }
            const ciphertext = encryptedSecrets[device.id];
            if (
              typeof ciphertext !== "string" ||
              ciphertext.length < 300 ||
              ciphertext.length > 800 ||
              !/^[A-Za-z0-9_-]+$/.test(ciphertext)
            ) {
              throw new Error("The encrypted event password is missing or invalid for a selected device.");
            }
          }
          if (Object.keys(encryptedSecrets).some((deviceId) => !selectedIds.includes(deviceId))) {
            throw new Error("Encrypted password data contains an unselected device.");
          }
        }

        const payload = {
          runId,
          eventUrl: run.event_url,
          eventTitle: run.event_title,
          releaseAt: run.release_at,
        };
        const timestamp = nowMs();
        const db = getD1();

        if (run.mode === "inspection") {
          const statements = selectedIds.flatMap((deviceId) => [
            db.prepare(
                `INSERT OR REPLACE INTO run_devices
                 (run_id, device_id, role, ticket_strategy, status)
                 VALUES (?, ?, 'inspection', ?, 'queued')`,
              )
              .bind(runId, deviceId, run.ticket_strategy),
            db.prepare(
              `INSERT INTO commands
               (id, owner_id, device_id, run_id, type, payload_json, status, created_at)
               VALUES (?, ?, ?, ?, 'inspect', ?, 'queued', ?)`,
            ).bind(
              crypto.randomUUID(),
              user.userId,
              deviceId,
              runId,
              JSON.stringify({
                ...payload,
                ticketStrategy: run.ticket_strategy,
                execute: false,
                ...(passwordIncluded ? { eventSecret: encryptedSecrets[deviceId] } : {}),
              }),
              timestamp,
            ),
          ]);
          statements.push(
            db.prepare("UPDATE runs SET status = 'armed', updated_at = ? WHERE id = ? AND owner_id = ?")
              .bind(timestamp, runId, user.userId),
          );
          await db.batch(statements);
        } else {
          if (!run.organizer_owned || !run.permission_confirmed) {
            throw new Error("The owned-event and written-permission confirmations are missing.");
          }
          if (body.confirmEventTitle !== run.event_title) {
            throw new Error("Type the exact event title to confirm this live test.");
          }
          const requestedFirstSlotCount = Number(body.firstSlotCount);
          const firstSlotCount = Number.isInteger(requestedFirstSlotCount)
            ? requestedFirstSlotCount
            : Math.ceil(selectedIds.length / 2);
          if (firstSlotCount < 0 || firstSlotCount > selectedIds.length) {
            throw new Error("The first-slot device count is invalid for the selected fleet.");
          }
          const assignments = new Map(
            selectedIds.map((deviceId, index) => [
              deviceId,
              index < firstSlotCount ? "first" : "second",
            ] as const),
          );
          const preparationSpreadMs = Math.max(
            0,
            Math.min(30_000, Number(run.release_at) - timestamp - 20_000),
          );
          const statements = selectedIds.flatMap((deviceId, deviceIndex) => {
            const leaseId = crypto.randomUUID();
            const assignedTicketStrategy = assignments.get(deviceId) ?? "first";
            const prepareAt = timestamp + (
              selectedIds.length > 1
                ? Math.round((preparationSpreadMs * deviceIndex) / (selectedIds.length - 1))
                : 0
            );
            return [
              db.prepare(
                `INSERT INTO leases (id, owner_id, run_id, device_id, status, created_at)
                 VALUES (?, ?, ?, ?, 'offered', ?)`,
              )
                .bind(leaseId, user.userId, runId, deviceId, timestamp),
              db.prepare(
                `INSERT OR REPLACE INTO run_devices
                 (run_id, device_id, role, ticket_strategy, status)
                 VALUES (?, ?, 'executor', ?, 'queued')`,
              )
                .bind(runId, deviceId, assignedTicketStrategy),
              db.prepare(
                `INSERT INTO commands
                 (id, owner_id, device_id, run_id, type, payload_json, status, created_at)
                 VALUES (?, ?, ?, ?, 'arm-live', ?, 'queued', ?)`,
              ).bind(
                crypto.randomUUID(),
                user.userId,
                deviceId,
                runId,
                JSON.stringify({
                ...payload,
                prepareAt,
                ticketStrategy: assignedTicketStrategy,
                execute: true,
                leaseId,
                fleetSize: selectedIds.length,
                ...(passwordIncluded ? { eventSecret: encryptedSecrets[deviceId] } : {}),
                }),
                timestamp,
              ),
            ];
          });
          statements.push(
            db.prepare("UPDATE runs SET status = 'armed', updated_at = ? WHERE id = ? AND owner_id = ?")
              .bind(timestamp, runId, user.userId),
          );
          await db.batch(statements);
        }
        await audit({
          ownerId: user.userId,
          runId,
          source: "control",
          action: "run-armed",
          detail: {
            mode: run.mode,
            devices: selectedIds.length,
            reservationTarget: run.mode === "live" ? selectedIds.length : 0,
            passwordDelivered: passwordIncluded,
            preparationSpreadMs:
              run.mode === "live"
                ? Math.max(0, Math.min(30_000, Number(run.release_at) - timestamp - 20_000))
                : 0,
            ...(run.mode === "live"
              ? {
                  firstSlotDevices: Number.isInteger(Number(body.firstSlotCount))
                    ? Number(body.firstSlotCount)
                    : Math.ceil(selectedIds.length / 2),
                  secondSlotDevices:
                    selectedIds.length -
                    (Number.isInteger(Number(body.firstSlotCount))
                      ? Number(body.firstSlotCount)
                      : Math.ceil(selectedIds.length / 2)),
                }
              : {}),
          },
        });
        return NextResponse.json({ ok: true });
      }

      case "stop-run": {
        const runId = nonEmpty(body.runId, "Run ID");
        const run = await getD1()
          .prepare("SELECT id, status FROM runs WHERE id = ? AND owner_id = ? LIMIT 1")
          .bind(runId, user.userId)
          .first<{ id: string; status: string }>();
        if (!run) throw new Error("Run not found.");
        const terminalStatuses = [
          "submitted",
          "confirmed",
          "submitted-unconfirmed",
          "already-reserved",
          "failed",
          "local-override",
          "stopped",
        ];
        const linked = await getD1()
          .prepare(
            `SELECT device_id FROM run_devices
             WHERE run_id = ? AND status NOT IN (${terminalStatuses.map(() => "?").join(",")})`,
          )
          .bind(runId, ...terminalStatuses)
          .all<{ device_id: string }>();
        for (const device of linked.results) {
          await queueCommand({
            ownerId: user.userId,
            deviceId: device.device_id,
            runId,
            type: "stop",
            payload: { runId },
          });
        }
        await getD1().batch([
          getD1()
            .prepare("UPDATE runs SET status = 'stopped', updated_at = ? WHERE id = ? AND owner_id = ?")
            .bind(nowMs(), runId, user.userId),
          getD1()
            .prepare("UPDATE leases SET status = 'blocked', completed_at = ? WHERE run_id = ? AND status IN ('offered', 'active')")
            .bind(nowMs(), runId),
          getD1()
            .prepare(
              `UPDATE run_devices SET status = 'stopped'
               WHERE run_id = ?
                 AND status NOT IN
                   ('submitted', 'confirmed', 'submitted-unconfirmed', 'already-reserved', 'failed', 'local-override', 'stopped')`,
            )
            .bind(runId),
        ]);
        await audit({ ownerId: user.userId, runId, source: "control", action: "run-stopped" });
        return NextResponse.json({ ok: true });
      }

      case "reset-devices": {
        const selectedIds = Array.isArray(body.deviceIds)
          ? [...new Set(body.deviceIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
          : [];
        if (!selectedIds.length) throw new Error("Select at least one device to reset.");
        if (selectedIds.length > 20) throw new Error("Select no more than 20 devices.");

        const placeholders = selectedIds.map(() => "?").join(",");
        const devices = await getD1()
          .prepare(
            `SELECT id, name, approval_status FROM devices
             WHERE owner_id = ? AND id IN (${placeholders})`,
          )
          .bind(user.userId, ...selectedIds)
          .all<{ id: string; name: string; approval_status: string }>();
        if (devices.results.length !== selectedIds.length) {
          throw new Error("One or more selected devices do not belong to this controller.");
        }
        if (devices.results.some((device) => device.approval_status !== "approved")) {
          throw new Error("Approve every selected device before resetting it.");
        }

        const activeRun = await getD1()
          .prepare(
            "SELECT id FROM runs WHERE owner_id = ? AND status IN ('draft', 'armed', 'blocked') LIMIT 1",
          )
          .bind(user.userId)
          .first<{ id: string }>();
        const timestamp = nowMs();
        const db = getD1();
        const statements = [
          db.prepare(
            `UPDATE commands SET status = 'acknowledged', acknowledged_at = ?
             WHERE owner_id = ? AND device_id IN (${placeholders})
               AND status IN ('queued', 'delivered')`,
          ).bind(timestamp, user.userId, ...selectedIds),
          ...selectedIds.map((deviceId) =>
            db.prepare(
              `INSERT INTO commands
               (id, owner_id, device_id, run_id, type, payload_json, status, created_at)
               VALUES (?, ?, ?, NULL, 'reset', '{}', 'queued', ?)`,
            ).bind(crypto.randomUUID(), user.userId, deviceId, timestamp),
          ),
        ];
        if (activeRun) {
          statements.push(
            db.prepare("UPDATE runs SET status = 'stopped', updated_at = ? WHERE id = ? AND owner_id = ?")
              .bind(timestamp, activeRun.id, user.userId),
            db.prepare(
              "UPDATE leases SET status = 'blocked', completed_at = ? WHERE run_id = ? AND status IN ('offered', 'active')",
            ).bind(timestamp, activeRun.id),
            db.prepare(
              `UPDATE run_devices SET status = 'stopped'
               WHERE run_id = ?
                 AND status NOT IN
                   ('submitted', 'confirmed', 'submitted-unconfirmed', 'already-reserved', 'failed', 'local-override', 'stopped')`,
            ).bind(activeRun.id),
          );
        }
        await db.batch(statements);
        await audit({
          ownerId: user.userId,
          runId: activeRun?.id ?? null,
          source: "control",
          action: "fleet-reset-requested",
          detail: { devices: selectedIds.length },
        });
        return NextResponse.json({
          ok: true,
          devices: selectedIds.length,
          stoppedRun: Boolean(activeRun),
        });
      }

      default:
        return jsonError("Unknown control action.");
    }
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error));
  }
}
