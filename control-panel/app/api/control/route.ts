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
  state_json: string;
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
  const [deviceResult, runResult, auditResult, leaseResult] = await db.batch([
    db.prepare(
      `SELECT id, name, version, mode, state_json, last_seen_at, created_at
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
       FROM leases WHERE owner_id = ? ORDER BY created_at DESC LIMIT 10`,
    ).bind(user.userId),
  ]);

  const onlineCutoff = nowMs() - 7_500;
  const devices = (deviceResult.results as unknown as DeviceRow[]).map((device) => ({
    id: device.id,
    name: device.name,
    version: device.version,
    mode: device.mode,
    state: parseJson<Record<string, unknown>>(device.state_json, {}),
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
            `INSERT INTO pairing_codes (code_hash, owner_id, label, expires_at, used_at, created_at)
             VALUES (?, ?, ?, ?, NULL, ?)`,
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
            `SELECT id, last_seen_at, state_json FROM devices
             WHERE owner_id = ? AND id IN (${placeholders})`,
          )
          .bind(user.userId, ...selectedIds)
          .all<{ id: string; last_seen_at: number | null; state_json: string }>();
        if (deviceRows.results.length !== selectedIds.length) throw new Error("One or more devices do not belong to this controller.");
        if (deviceRows.results.some((device) => !device.last_seen_at || device.last_seen_at < nowMs() - 7_500)) {
          throw new Error("Every selected device must be online before arming.");
        }
        if (
          deviceRows.results.some(
            (device) => parseJson<Record<string, unknown>>(device.state_json, {}).controlConnected !== true,
          )
        ) {
          throw new Error("Every selected device must have command-center control enabled locally.");
        }

        const payload = {
          runId,
          eventUrl: run.event_url,
          eventTitle: run.event_title,
          releaseAt: run.release_at,
          ticketStrategy: run.ticket_strategy,
        };
        const timestamp = nowMs();

        if (run.mode === "inspection") {
          for (const deviceId of selectedIds) {
            await getD1()
              .prepare(
                `INSERT OR REPLACE INTO run_devices (run_id, device_id, role, status)
                 VALUES (?, ?, 'inspection', 'queued')`,
              )
              .bind(runId, deviceId)
              .run();
            await queueCommand({
              ownerId: user.userId,
              deviceId,
              runId,
              type: "inspect",
              payload: { ...payload, execute: false },
            });
          }
        } else {
          if (!run.organizer_owned || !run.permission_confirmed) {
            throw new Error("The owned-event and written-permission confirmations are missing.");
          }
          if (body.confirmEventTitle !== run.event_title) {
            throw new Error("Type the exact event title to confirm this live test.");
          }
          const primaryDeviceId = nonEmpty(body.primaryDeviceId, "Primary device");
          if (!selectedIds.includes(primaryDeviceId)) throw new Error("The primary must be a selected device.");
          const leaseId = crypto.randomUUID();
          await getD1()
            .prepare(
              `INSERT INTO leases (id, owner_id, run_id, device_id, status, created_at)
               VALUES (?, ?, ?, ?, 'offered', ?)`,
            )
            .bind(leaseId, user.userId, runId, primaryDeviceId, timestamp)
            .run();
          for (const deviceId of selectedIds) {
            const isPrimary = deviceId === primaryDeviceId;
            await getD1()
              .prepare(
                `INSERT OR REPLACE INTO run_devices (run_id, device_id, role, status)
                 VALUES (?, ?, ?, 'queued')`,
              )
              .bind(runId, deviceId, isPrimary ? "primary" : "standby")
              .run();
            await queueCommand({
              ownerId: user.userId,
              deviceId,
              runId,
              type: isPrimary ? "arm-live" : "standby",
              payload: isPrimary
                ? { ...payload, execute: true, leaseId }
                : { runId, eventTitle: run.event_title, primaryDeviceId },
            });
          }
        }

        await getD1()
          .prepare("UPDATE runs SET status = 'armed', updated_at = ? WHERE id = ? AND owner_id = ?")
          .bind(timestamp, runId, user.userId)
          .run();
        await audit({
          ownerId: user.userId,
          runId,
          source: "control",
          action: "run-armed",
          detail: { mode: run.mode, devices: selectedIds.length },
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
