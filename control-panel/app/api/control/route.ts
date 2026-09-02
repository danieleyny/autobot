import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { audit, ensureControlSchema, nowMs, parseJson, randomPairingCode, sha256 } from "../../../db/control";
import { getD1 } from "../../../db";
import {
  CONTROLLER_OWNER_ID,
  isSameOriginRequest,
  isValidPinSession,
  PIN_SESSION_COOKIE,
} from "../../pin-auth";

type DeviceRow = {
  id: string;
  name: string;
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

function supportsFleetExecution(version: string): boolean {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || minor >= 10;
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
      `SELECT id, name, version, mode, approval_status, state_json, public_key, last_seen_at, created_at
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
      `SELECT run_devices.run_id, run_devices.device_id, run_devices.role, run_devices.status,
              devices.name AS device_name, runs.updated_at
       FROM run_devices
       JOIN devices ON devices.id = run_devices.device_id
       JOIN runs ON runs.id = run_devices.run_id
       WHERE runs.owner_id = ?
       ORDER BY runs.updated_at DESC, devices.name ASC LIMIT 240`,
    ).bind(user.userId),
  ]);

  const onlineCutoff = nowMs() - 7_500;
  const devices = (deviceResult.results as unknown as DeviceRow[]).map((device) => ({
    id: device.id,
    name: device.name,
    version: device.version,
    mode: device.mode,
    approvalStatus: device.approval_status,
    state: parseJson<Record<string, unknown>>(device.state_json, {}),
    encryptionPublicKey: device.public_key,
    encryptionReady: Boolean(device.public_key),
    lastSeenAt: device.last_seen_at,
    online: Boolean(device.last_seen_at && device.last_seen_at >= onlineCutoff),
    createdAt: device.created_at,
  }));
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
        const expiresAt = createdAt + 2 * 60 * 60_000;
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
        if (deviceStates.some((device) => !device.last_seen_at || device.last_seen_at < nowMs() - 7_500)) {
          throw new Error("Every selected device must be online before arming.");
        }
        if (deviceStates.some((device) => device.state.controlConnected !== true)) {
          throw new Error("Every selected device must have command-center control enabled locally.");
        }
        if (deviceStates.some((device) => !sameEventPage(device.state.eventUrl, run.event_url))) {
          throw new Error("Every selected device must have the configured event page open before arming.");
        }
        if (deviceStates.some((device) => !sameEventTitle(device.state.eventTitle, run.event_title))) {
          throw new Error("Every selected device must show the configured event title before arming.");
        }
        if (run.mode === "live" && deviceStates.some((device) => !supportsFleetExecution(device.version))) {
          throw new Error("Every selected device must run AUTOBOT v0.10.0 or newer for a live fleet test.");
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
          ticketStrategy: run.ticket_strategy,
        };
        const timestamp = nowMs();
        const db = getD1();

        if (run.mode === "inspection") {
          const statements = selectedIds.flatMap((deviceId) => [
            db.prepare(
                `INSERT OR REPLACE INTO run_devices (run_id, device_id, role, status)
                 VALUES (?, ?, 'inspection', 'queued')`,
              )
              .bind(runId, deviceId),
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
          const statements = selectedIds.flatMap((deviceId) => {
            const leaseId = crypto.randomUUID();
            return [
              db.prepare(
                `INSERT INTO leases (id, owner_id, run_id, device_id, status, created_at)
                 VALUES (?, ?, ?, ?, 'offered', ?)`,
              )
                .bind(leaseId, user.userId, runId, deviceId, timestamp),
              db.prepare(
                `INSERT OR REPLACE INTO run_devices (run_id, device_id, role, status)
                 VALUES (?, ?, 'executor', 'queued')`,
              )
                .bind(runId, deviceId),
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
        const linked = await getD1()
          .prepare("SELECT device_id FROM run_devices WHERE run_id = ?")
          .bind(runId)
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
        ]);
        await audit({ ownerId: user.userId, runId, source: "control", action: "run-stopped" });
        return NextResponse.json({ ok: true });
      }

      default:
        return jsonError("Unknown control action.");
    }
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error));
  }
}
