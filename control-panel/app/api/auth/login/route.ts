import { NextRequest, NextResponse } from "next/server";
import { ensureControlSchema, nowMs, sha256 } from "../../../../db/control";
import { getD1 } from "../../../../db";
import {
  createPinSessionToken,
  isSameOriginRequest,
  PIN_SESSION_COOKIE,
  sessionCookieOptions,
  verifyConfiguredPin,
} from "../../../pin-auth";

const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;

type AttemptRow = {
  blocked_until: number | null;
  failures: number;
  window_started_at: number;
};

function response(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { headers: { "cache-control": "no-store" }, status });
}

function clientAddress(request: NextRequest): string {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip") ?? "unknown-client";
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return response({ error: "The request origin is not allowed." }, 403);
  await ensureControlSchema();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return response({ error: "Enter the dashboard PIN." }, 400);
  }
  const pin = typeof body.pin === "string" ? body.pin.trim() : "";
  if (!/^\d{6,12}$/u.test(pin)) return response({ error: "Enter the 6–12 digit dashboard PIN." }, 400);

  const timestamp = nowMs();
  const clientHash = await sha256(`pin-login:${clientAddress(request)}`);
  const attempt = await getD1()
    .prepare("SELECT failures, window_started_at, blocked_until FROM pin_login_attempts WHERE client_hash = ?")
    .bind(clientHash)
    .first<AttemptRow>();
  if (attempt?.blocked_until && attempt.blocked_until > timestamp) {
    const retryAfter = Math.max(1, Math.ceil((attempt.blocked_until - timestamp) / 1_000));
    const blocked = response({ error: `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minutes.` }, 429);
    blocked.headers.set("retry-after", String(retryAfter));
    return blocked;
  }

  if (!(await verifyConfiguredPin(pin))) {
    const insideWindow = Boolean(attempt && timestamp - attempt.window_started_at < WINDOW_MS);
    const failures = insideWindow ? attempt!.failures + 1 : 1;
    const windowStartedAt = insideWindow ? attempt!.window_started_at : timestamp;
    const blockedUntil = failures >= MAX_FAILURES ? timestamp + WINDOW_MS : null;
    await getD1()
      .prepare(
        `INSERT INTO pin_login_attempts (client_hash, failures, window_started_at, blocked_until, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(client_hash) DO UPDATE SET failures = excluded.failures,
           window_started_at = excluded.window_started_at, blocked_until = excluded.blocked_until,
           updated_at = excluded.updated_at`,
      )
      .bind(clientHash, failures, windowStartedAt, blockedUntil, timestamp)
      .run();
    return response(
      { error: failures >= MAX_FAILURES ? "Too many attempts. Try again in 15 minutes." : "That PIN is not correct." },
      failures >= MAX_FAILURES ? 429 : 401,
    );
  }

  await getD1().batch([
    getD1().prepare("DELETE FROM pin_login_attempts WHERE client_hash = ?").bind(clientHash),
    getD1()
      .prepare("DELETE FROM pin_login_attempts WHERE updated_at < ?")
      .bind(timestamp - 7 * 24 * 60 * 60_000),
  ]);
  const unlocked = response({ ok: true });
  unlocked.cookies.set(
    PIN_SESSION_COOKIE,
    await createPinSessionToken(timestamp),
    sessionCookieOptions(request.nextUrl.protocol === "https:"),
  );
  return unlocked;
}
