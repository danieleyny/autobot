import { getD1 } from "./index";

let schemaReady: Promise<void> | null = null;

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    public_key TEXT,
    version TEXT NOT NULL DEFAULT 'unknown',
    mode TEXT NOT NULL DEFAULT 'local',
    state_json TEXT NOT NULL DEFAULT '{}',
    last_seen_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_token_hash ON devices(token_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_devices_owner_last_seen ON devices(owner_id, last_seen_at)`,
  `CREATE TABLE IF NOT EXISTS pairing_codes (
    code_hash TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    label TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pairing_owner_expires ON pairing_codes(owner_id, expires_at)`,
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    event_url TEXT NOT NULL,
    event_title TEXT NOT NULL,
    release_at INTEGER NOT NULL,
    ticket_strategy TEXT NOT NULL DEFAULT 'any',
    mode TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    organizer_owned INTEGER NOT NULL DEFAULT 0,
    permission_confirmed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_owner_updated ON runs(owner_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS run_devices (
    run_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    PRIMARY KEY (run_id, device_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_run_devices_device ON run_devices(device_id)`,
  `CREATE TABLE IF NOT EXISTS commands (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    run_id TEXT,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'queued',
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    acknowledged_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_commands_device_status_created ON commands(device_id, status, created_at)`,
  `CREATE TABLE IF NOT EXISTS leases (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'offered',
    created_at INTEGER NOT NULL,
    activated_at INTEGER,
    completed_at INTEGER
  )`,
  `DROP INDEX IF EXISTS idx_leases_run`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_leases_run_device ON leases(run_id, device_id)`,
  `CREATE INDEX IF NOT EXISTS idx_leases_device_status ON leases(device_id, status)`,
  `CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    run_id TEXT,
    device_id TEXT,
    source TEXT NOT NULL,
    action TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_owner_created ON audit_events(owner_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS pin_login_attempts (
    client_hash TEXT PRIMARY KEY,
    failures INTEGER NOT NULL DEFAULT 0,
    window_started_at INTEGER NOT NULL,
    blocked_until INTEGER,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pin_attempts_updated ON pin_login_attempts(updated_at)`,
];

export async function ensureControlSchema(): Promise<void> {
  if (!schemaReady) {
    const db = getD1();
    schemaReady = db
      .batch(schemaStatements.map((statement) => db.prepare(statement)))
      .then(async () => {
        const columns = await db.prepare("PRAGMA table_info(devices)").all<{ name: string }>();
        if (!columns.results.some((column) => column.name === "public_key")) {
          await db.prepare("ALTER TABLE devices ADD COLUMN public_key TEXT").run();
        }
        await db.prepare("PRAGMA optimize").run();
      })
      .catch((error) => {
        schemaReady = null;
        throw error;
      });
  }
  await schemaReady;
}

export function nowMs(): number {
  return Date.now();
}

export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomPairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const value = new Uint8Array(8);
  crypto.getRandomValues(value);
  return [...value].map((byte) => alphabet[byte % alphabet.length]).join("");
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function audit(input: {
  ownerId: string;
  runId?: string | null;
  deviceId?: string | null;
  source: string;
  action: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await ensureControlSchema();
  await getD1()
    .prepare(
      `INSERT INTO audit_events
       (id, owner_id, run_id, device_id, source, action, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.ownerId,
      input.runId ?? null,
      input.deviceId ?? null,
      input.source,
      input.action,
      JSON.stringify(input.detail ?? {}),
      nowMs(),
    )
    .run();
}
