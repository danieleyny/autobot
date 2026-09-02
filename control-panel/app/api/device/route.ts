import { NextRequest, NextResponse } from "next/server";
import { audit, ensureControlSchema, nowMs, parseJson, randomToken, sha256 } from "../../../db/control";
import { getD1 } from "../../../db";

type DeviceAuth = { id: string; owner_id: string; name: string; approval_status: "pending" | "approved" };

function optionalPublicKey(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("Device public key must be text.");
  const normalized = value.trim();
  if (
    normalized.length < 400 ||
    normalized.length > 1_000 ||
    !/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PUBLIC KEY-----$/.test(normalized)
  ) {
    throw new Error("Device public key is invalid.");
  }
  return `${normalized}\n`;
}

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

async function authenticateDevice(request: NextRequest): Promise<DeviceAuth | null> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const tokenHash = await sha256(token);
  return getD1()
    .prepare("SELECT id, owner_id, name, approval_status FROM devices WHERE token_hash = ? LIMIT 1")
    .bind(tokenHash)
    .first<DeviceAuth>();
}

async function finalizeRunIfSettled(runId: string, ownerId: string, timestamp: number) {
  const run = await getD1()
    .prepare("SELECT status, mode FROM runs WHERE id = ? AND owner_id = ? LIMIT 1")
    .bind(runId, ownerId)
    .first<{ status: string; mode: string }>();
  if (!run || run.status === "stopped") return;

  const role = run.mode === "live" ? "executor" : "inspection";
  const terminalStatuses =
    run.mode === "live"
      ? ["confirmed", "submitted-unconfirmed", "already-reserved", "failed", "local-override", "stopped"]
      : ["inspection-complete", "failed", "local-override", "stopped"];
  const terminalPlaceholders = terminalStatuses.map(() => "?").join(",");

  const summary = await getD1()
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status IN (${terminalPlaceholders}) THEN 1 ELSE 0 END) AS terminal
       FROM run_devices WHERE run_id = ? AND role = ?`,
    )
    .bind(...terminalStatuses, runId, role)
    .first<{ total: number; terminal: number }>();
  const total = Number(summary?.total ?? 0);
  if (!total || Number(summary?.terminal ?? 0) < total) return;
  await getD1()
    .prepare("UPDATE runs SET status = 'completed', updated_at = ? WHERE id = ? AND owner_id = ?")
    .bind(timestamp, runId, ownerId)
    .run();
}

export async function POST(request: NextRequest) {
  await ensureControlSchema();
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError("A JSON request body is required.");
  }

  try {
    if (body.action === "pair") {
      const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
      if (!code) return jsonError("Pairing code is required.");
      const codeHash = await sha256(code);
      const pairing = await getD1()
        .prepare(
          `SELECT owner_id, label, expires_at, max_uses, used_count, approval_required FROM pairing_codes
           WHERE code_hash = ? LIMIT 1`,
        )
        .bind(codeHash)
        .first<{
          owner_id: string;
          label: string;
          expires_at: number;
          max_uses: number;
          used_count: number;
          approval_required: number;
        }>();
      const timestamp = nowMs();
      if (!pairing || pairing.used_count >= pairing.max_uses || pairing.expires_at < timestamp) {
        return jsonError("Pairing code is invalid, expired, or full.", 401);
      }
      const claimed = await getD1()
        .prepare(
          `UPDATE pairing_codes
           SET used_count = used_count + 1,
               used_at = CASE WHEN used_count + 1 >= max_uses THEN ? ELSE used_at END
           WHERE code_hash = ? AND expires_at >= ? AND used_count < max_uses`,
        )
        .bind(timestamp, codeHash, timestamp)
        .run();
      if (!claimed.meta.changes) return jsonError("Pairing code was already used or is full.", 409);

      const deviceId = crypto.randomUUID();
      const token = randomToken();
      const tokenHash = await sha256(token);
      const name =
        typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : pairing.label;
      const version =
        typeof body.version === "string" && body.version.trim() ? body.version.trim().slice(0, 32) : "unknown";
      const publicKey = optionalPublicKey(body.publicKey);
      const approvalStatus = pairing.approval_required ? "pending" : "approved";
      await getD1()
        .prepare(
          `INSERT INTO devices
           (id, owner_id, name, token_hash, public_key, version, mode, approval_status,
            state_json, last_seen_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'local', ?, '{}', NULL, ?)`,
        )
        .bind(deviceId, pairing.owner_id, name, tokenHash, publicKey, version, approvalStatus, timestamp)
        .run();
      await audit({
        ownerId: pairing.owner_id,
        deviceId,
        source: "device",
        action: "device-paired",
        detail: { name, version, approvalStatus },
      });
      return NextResponse.json({ approvalStatus, deviceId, token, name });
    }

    const device = await authenticateDevice(request);
    if (!device) return jsonError("Valid device credentials are required.", 401);

    if (body.action === "poll") {
      const status = body.status && typeof body.status === "object" ? body.status : {};
      const version =
        typeof body.version === "string" && body.version.trim() ? body.version.trim().slice(0, 32) : "unknown";
      const publicKey = optionalPublicKey(body.publicKey);
      const timestamp = nowMs();
      const mode = (status as Record<string, unknown>).controlConnected === true ? "managed" : "local";
      await getD1()
        .prepare(
          `UPDATE devices
           SET version = ?, mode = ?, state_json = ?, last_seen_at = ?,
               public_key = COALESCE(?, public_key)
           WHERE id = ?`,
        )
        .bind(version, mode, JSON.stringify(status), timestamp, publicKey, device.id)
        .run();

      if (device.approval_status !== "approved") {
        return NextResponse.json({ approvalPending: true, serverTime: timestamp, command: null });
      }

      const command = await getD1()
        .prepare(
          `SELECT id, run_id, type, payload_json, status, created_at FROM commands
           WHERE device_id = ? AND status IN ('queued', 'delivered')
           ORDER BY created_at ASC LIMIT 1`,
        )
        .bind(device.id)
        .first<{
          id: string;
          run_id: string | null;
          type: string;
          payload_json: string;
          status: string;
          created_at: number;
        }>();
      if (command) {
        if (command.status === "queued") {
          await getD1()
            .prepare(
              `UPDATE commands SET status = 'delivered', delivered_at = ?
               WHERE id = ? AND device_id = ? AND status = 'queued'`,
            )
            .bind(timestamp, command.id, device.id)
            .run();
          await audit({
            ownerId: device.owner_id,
            runId: command.run_id,
            deviceId: device.id,
            source: device.name,
            action: "command-delivered",
            detail: { commandId: command.id, type: command.type },
          });
        }
        return NextResponse.json({
          serverTime: timestamp,
          command: {
            id: command.id,
            runId: command.run_id,
            type: command.type,
            payload: parseJson(command.payload_json, {}),
          },
        });
      }
      return NextResponse.json({ serverTime: timestamp, command: null });
    }

    if (device.approval_status !== "approved") {
      return jsonError("This laptop is waiting for Command Center approval.", 403);
    }

    if (body.action === "report") {
      const commandId = typeof body.commandId === "string" ? body.commandId : "";
      const phase = typeof body.phase === "string" ? body.phase : "status";
      const detail = body.detail && typeof body.detail === "object" ? body.detail : {};
      const command = commandId
        ? await getD1()
            .prepare("SELECT id, run_id, type FROM commands WHERE id = ? AND device_id = ? LIMIT 1")
            .bind(commandId, device.id)
            .first<{ id: string; run_id: string | null; type: string }>()
        : null;
      const runId = command?.run_id ?? (typeof body.runId === "string" ? body.runId : null);
      const timestamp = nowMs();
      if (command) {
        await getD1()
          .prepare(
            `UPDATE commands SET status = ?, acknowledged_at = ?
             WHERE id = ? AND device_id = ?`,
          )
          .bind(phase === "failed" ? "failed" : "acknowledged", timestamp, command.id, device.id)
          .run();
      }

      if (runId && phase === "execution-started") {
        const activated = await getD1()
          .prepare(
            `UPDATE leases SET status = 'active', activated_at = ?
             WHERE run_id = ? AND device_id = ? AND status = 'offered'`,
          )
          .bind(timestamp, runId, device.id)
          .run();
        if (!activated.meta.changes) return jsonError("No live execution lease is available for this device.", 409);
      }

      if (runId && ["submitted", "confirmed", "submitted-unconfirmed"].includes(phase)) {
        await getD1().batch([
          getD1()
            .prepare(
              `UPDATE leases SET status = 'submitted', completed_at = ?
               WHERE run_id = ? AND device_id = ? AND status = 'active'`,
            )
            .bind(timestamp, runId, device.id),
          getD1()
            .prepare("UPDATE run_devices SET status = ? WHERE run_id = ? AND device_id = ?")
            .bind(phase, runId, device.id),
        ]);
        if (phase !== "submitted") {
          await finalizeRunIfSettled(runId, device.owner_id, timestamp);
        }
      } else if (runId && ["already-reserved", "failed", "local-override", "stopped"].includes(phase)) {
        await getD1().batch([
          getD1()
            .prepare(
              `UPDATE leases SET status = 'blocked', completed_at = ?
               WHERE run_id = ? AND device_id = ? AND status IN ('offered', 'active')`,
            )
            .bind(timestamp, runId, device.id),
          getD1()
            .prepare("UPDATE run_devices SET status = ? WHERE run_id = ? AND device_id = ?")
            .bind(phase, runId, device.id),
        ]);
        await finalizeRunIfSettled(runId, device.owner_id, timestamp);
      } else if (runId) {
        await getD1()
          .prepare("UPDATE run_devices SET status = ? WHERE run_id = ? AND device_id = ?")
          .bind(phase.slice(0, 60), runId, device.id)
          .run();
        if (phase === "inspection-complete") {
          await finalizeRunIfSettled(runId, device.owner_id, timestamp);
        }
      }

      await audit({
        ownerId: device.owner_id,
        runId,
        deviceId: device.id,
        source: device.name,
        action: phase.slice(0, 80),
        detail: detail as Record<string, unknown>,
      });
      return NextResponse.json({ ok: true });
    }

    return jsonError("Unknown device action.");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error));
  }
}
