// Controller-only compatibility patch. Existing v0.11.x bridges still poll at
// their original cadence; command delivery and reports must not be throttled.
export const CONTROLLER_REVISION = "0.11.1-presence.1";
export const DEVICE_KEEPALIVE_WRITE_MS = 5_000;
export const DEVICE_CONNECTION_GRACE_MS = 7_500;
export const DEVICE_ONLINE_WINDOW_MS = DEVICE_KEEPALIVE_WRITE_MS + DEVICE_CONNECTION_GRACE_MS;

export function isDeviceOnline(lastSeenAt: number | null, now: number): boolean {
  return lastSeenAt !== null && lastSeenAt > 0 && lastSeenAt >= now - DEVICE_ONLINE_WINDOW_MS;
}

// Evaluate the condition in D1, not a Worker-local cache: concurrent polls and
// separate Worker instances must share the same persisted keepalive deadline.
// Status/key/version changes are saved immediately. Identical polls touch no
// rows until the keepalive is due. The WHERE id predicate remains indexed.
export const DEVICE_POLL_UPDATE_SQL = `UPDATE devices
  SET version = ?, mode = ?, state_json = ?, last_seen_at = ?,
      public_key = COALESCE(?, public_key)
  WHERE id = ? AND (
    last_seen_at IS NULL OR last_seen_at <= ?
    OR version <> ? OR mode <> ? OR state_json <> ?
    OR (? IS NOT NULL AND public_key IS NOT ?)
  )`;

export function devicePollUpdateBindings(input: {
  id: string;
  version: string;
  mode: string;
  stateJson: string;
  publicKey: string | null;
  now: number;
}): Array<string | number | null> {
  return [
    input.version, input.mode, input.stateJson, input.now, input.publicKey, input.id,
    input.now - DEVICE_KEEPALIVE_WRITE_MS,
    input.version, input.mode, input.stateJson, input.publicKey, input.publicKey,
  ];
}
