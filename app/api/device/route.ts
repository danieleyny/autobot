import { NextRequest, NextResponse } from "next/server";
import { audit, ensureControlSchema, nowMs, parseJson, randomToken, sha256 } from "../../../db/control";
import { getD1 } from "../../../db";

type DeviceAuth = { id: string; owner_id: string; name: string };

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
    .prepare("SELECT id, owner_id, name FROM devices WHERE token_hash = ? LIMIT 1")
    .bind(tokenHash)
    .first<DeviceAuth>();
}

async function finalizeLiveRunIfSettled(runId: string, ownerId: string, timestamp: number) {
  const run = await getD1()
    .prepare("SELECT status, mode FROM runs WHERE id = ? AND owner_id = ? LIMIT 1")
    .bind(runId, ownerId)
    .first<{ status: string; mode: string }>();
  if (!run || run.mode !== "live" || run.status === "stopped") return;

  const summary = await getD1()
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status IN
           ('submitted', 'confirmed', 'submitted-unconfirmed', 'failed', 'local-override', 'stopped')
           THEN 1 ELSE 0 END) AS terminal,
         SUM(CASE WHEN status IN ('failed', 'local-override', 'stopped') THEN 1 ELSE 0 END) AS failed
       FROM run_devices WHERE run_id = ? AND role = 'executor'`,
    )
    .bind(runId)
    .first<{ total: number; terminal: number; failed: number }>();
  const total = Number(summary?.total ?? 0);
  if (!total || Number(summary?.terminal ?? 0) < total) return;
  await getD1()
    .prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
    .bind(Number(summary?.failed ?? 0) > 0 ? "blocked" : "completed", timestamp, runId, ownerId)
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
          `SELECT owner_id, label, expires_at, used_at FROM pairing_codes
           WHERE code_hash = ? LIMIT 1`,
        )
        .bind(codeHash)
        .first<{ owner_id: string; label: string; expires_at: number; used_at: number | null }>();
      if (!pairing || pairing.used_at || pairing.expires_at < nowMs()) {
        return jsonError("Pairing code is invalid, expired, or already used.", 401);
      }
      const claimed = await getD1()
        .prepare("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL")
        .bind(nowMs(), codeHash)
        .run();
      if (!claimed.meta.changes) return jsonError("Pairing code was already used.", 409);

      const deviceId = crypto.randomUUID();
      const token = randomToken();
      const tokenHash = await sha256(token);
      const name =
        typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : pairing.label;
      const version =
        typeof body.version === "string" && body.version.trim() ? body.version.trim().slice(0, 32) : "unknown";
      const publicKey = optionalPublicKey(body.publicKey);
      await getD1()
        .prepare(
          `INSERT INTO devices
           (id, owner_id, name, token_hash, public_key, version, mode, state_json, last_seen_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'local', '{}', NULL, ?)`,
        )
        .bind(deviceId, pairing.owner_id, name, tokenHash, publicKey, version, nowMs())
        .run();
      await audit({
        ownerId: pairing.owner_id,
        deviceId,
        source: "device",
        action: "device-paired",
        detail: { name, version },
      });
      return NextResponse.json({ deviceId, token, name });
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
        await finalizeLiveRunIfSettled(runId, device.owner_id, timestamp);
      } else if (runId && ["failed", "local-override", "stopped"].includes(phase)) {
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
        await finalizeLiveRunIfSettled(runId, device.owner_id, timestamp);
      } else if (runId) {
        await getD1()
          .prepare("UPDATE run_devices SET status = ? WHERE run_id = ? AND device_id = ?")
          .bind(phase.slice(0, 60), runId, device.id)
          .run();
        if (phase === "inspection-complete") {
          const remaining = await getD1()
            .prepare(
              `SELECT COUNT(*) AS count FROM run_devices
               WHERE run_id = ? AND role = 'inspection' AND status != 'inspection-complete'`,
            )
            .bind(runId)
            .first<{ count: number }>();
          if (Number(remaining?.count ?? 1) === 0) {
            await getD1()
              .prepare("UPDATE runs SET status = 'completed', updated_at = ? WHERE id = ? AND owner_id = ?")
              .bind(timestamp, runId, device.owner_id)
              .run();
          }
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
