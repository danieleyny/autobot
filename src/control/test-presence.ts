import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  DEVICE_KEEPALIVE_WRITE_MS,
  DEVICE_ONLINE_WINDOW_MS,
  DEVICE_POLL_UPDATE_SQL,
  deviceOnlineWindowMs,
  devicePollUpdateBindings,
  isDeviceOnline,
} from "../../control-panel/db/device-presence.js";
import { singleFlight, startDashboardPolling } from "../../control-panel/app/dashboard-polling.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE devices (
    id TEXT PRIMARY KEY, version TEXT NOT NULL, mode TEXT NOT NULL,
    state_json TEXT NOT NULL, public_key TEXT, last_seen_at INTEGER,
    token_hash TEXT, approval_status TEXT, contact_email TEXT
  );
  CREATE INDEX idx_devices_last_seen ON devices(last_seen_at);
  INSERT INTO devices VALUES ('existing', '0.11.1', 'local', '{}', 'saved-key', NULL,
    'saved-token', 'approved', 'device@example.com');`);
  const statement = db.prepare(DEVICE_POLL_UPDATE_SQL);
  const input = {
    id: "existing", version: "0.11.1", mode: "managed", stateJson: '{"pageReady":true}',
    publicKey: "saved-key", now: 1_000_000,
  };
  const poll = (changes: Partial<typeof input> = {}) =>
    statement.run(...devicePollUpdateBindings({ ...input, ...changes })).changes;
  const row = () => db.prepare("SELECT * FROM devices WHERE id = 'existing'").get()!;
  return { db, input, poll, row };
}

test("one-second legacy polls save five-second keepalives without losing presence", () => {
  const { db, input, poll, row } = fixture();
  try {
    let writes = 0;
    for (let tick = 0; tick < 60; tick++) {
      const now = input.now + tick * 1_000;
      writes += Number(poll({ now }));
      assert.equal(isDeviceOnline(Number(row().last_seen_at), now), true);
    }
    assert.equal(writes, 12, "60 steady polls should perform 12 row updates, not 60");
    assert.equal(row().token_hash, "saved-token");
    assert.equal(row().approval_status, "approved");
    assert.equal(row().contact_email, "device@example.com");
    assert.equal(row().public_key, "saved-key");
  } finally { db.close(); }
});

test("status, version, mode, and key changes bypass keepalive coalescing", () => {
  const { db, input, poll, row } = fixture();
  try {
    assert.equal(poll(), 1);
    assert.equal(poll({ now: input.now + 1 }), 0);
    assert.equal(poll({ now: input.now + 2, stateJson: '{"pageReady":false}' }), 1);
    assert.equal(row().state_json, '{"pageReady":false}');
    assert.equal(poll({ now: input.now + 3, version: "0.11.0" }), 1);
    assert.equal(row().version, "0.11.0");
    assert.equal(poll({ now: input.now + 4, mode: "local" }), 1);
    assert.equal(row().mode, "local");
    assert.equal(poll({ now: input.now + 5, publicKey: "replacement-key" }), 1);
    assert.equal(row().public_key, "replacement-key");
    const omittedKey = devicePollUpdateBindings({ ...input, now: input.now + 6, publicKey: null });
    assert.equal(db.prepare(DEVICE_POLL_UPDATE_SQL).run(...omittedKey).changes, 0);
    assert.equal(row().public_key, "replacement-key", "missing key must never erase saved encryption");
  } finally { db.close(); }
});

test("parallel duplicate polls cannot repeatedly write a due keepalive", () => {
  const { db, input, poll } = fixture();
  try {
    assert.equal(poll(), 1);
    const now = input.now + DEVICE_KEEPALIVE_WRITE_MS;
    let writes = 0;
    for (let index = 0; index < 100; index++) writes += Number(poll({ now }));
    assert.equal(writes, 1, "the SQL condition must use persisted state, not a process-local cache");
  } finally { db.close(); }
});

test("presence accounts for both saved keepalive age and the original connection grace", () => {
  assert.equal(DEVICE_ONLINE_WINDOW_MS, 12_500);
  assert.equal(isDeviceOnline(null, 20_000), false);
  assert.equal(isDeviceOnline(0, 20_000), false);
  assert.equal(isDeviceOnline(10_000, 22_500), true);
  assert.equal(isDeviceOnline(10_000, 22_501), false);
  assert.equal(deviceOnlineWindowMs({ pollIntervalMs: 15_000 }), 37_500);
  assert.equal(isDeviceOnline(10_000, 47_500, { pollIntervalMs: 15_000 }), true);
  assert.equal(isDeviceOnline(10_000, 47_501, { pollIntervalMs: 15_000 }), false);
  assert.equal(deviceOnlineWindowMs({ pollIntervalMs: 99_999 }), DEVICE_ONLINE_WINDOW_MS);
});

test("dashboard coalesces concurrent refreshes and recovers after an error", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const refresh = singleFlight(async () => { calls++; await gate; });
  const first = refresh();
  assert.equal(refresh(), first);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  await first;
  await refresh();
  assert.equal(calls, 2);

  let attempts = 0;
  const retry = singleFlight(async () => { if (++attempts === 1) throw new Error("temporary"); });
  await assert.rejects(retry(), /temporary/);
  await retry();
  assert.equal(attempts, 2);
});

test("hidden dashboards stop scheduled traffic and refresh on return", async () => {
  const timeouts = new Map<number, () => void>();
  const intervals = new Map<number, () => void>();
  const listeners = new Set<() => void>();
  let id = 0;
  let requests = 0;
  const visibility = {
    visibilityState: "hidden",
    addEventListener: (_type: "visibilitychange", listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_type: "visibilitychange", listener: () => void) => { listeners.delete(listener); },
  };
  const clock = {
    setTimeout: (callback: () => void) => { timeouts.set(++id, callback); return id; },
    clearTimeout: (key: number) => { timeouts.delete(key); },
    setInterval: (callback: () => void, delay: number) => {
      assert.equal(delay, 5_000); intervals.set(++id, callback); return id;
    },
    clearInterval: (key: number) => { intervals.delete(key); },
  };
  const cleanup = startDashboardPolling(async () => { requests++; }, visibility, clock, (error) => assert.fail(String(error)));
  for (const callback of timeouts.values()) callback();
  for (const callback of intervals.values()) callback();
  assert.equal(requests, 0);
  visibility.visibilityState = "visible";
  for (const callback of listeners) callback();
  assert.equal(requests, 1);
  for (const callback of intervals.values()) callback();
  assert.equal(requests, 2);
  visibility.visibilityState = "hidden";
  for (const callback of listeners) callback();
  for (const callback of intervals.values()) callback();
  assert.equal(requests, 2);
  cleanup();
  assert.equal(timeouts.size + intervals.size + listeners.size, 0);
});
