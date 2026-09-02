import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    version: text("version").notNull().default("unknown"),
    mode: text("mode", { enum: ["local", "managed"] }).notNull().default("local"),
    stateJson: text("state_json").notNull().default("{}"),
    lastSeenAt: integer("last_seen_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_devices_token_hash").on(table.tokenHash),
    index("idx_devices_owner_last_seen").on(table.ownerId, table.lastSeenAt),
  ],
);

export const pairingCodes = sqliteTable(
  "pairing_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    ownerId: text("owner_id").notNull(),
    label: text("label").notNull(),
    expiresAt: integer("expires_at").notNull(),
    usedAt: integer("used_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_pairing_owner_expires").on(table.ownerId, table.expiresAt)],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    title: text("title").notNull(),
    eventUrl: text("event_url").notNull(),
    eventTitle: text("event_title").notNull(),
    releaseAt: integer("release_at").notNull(),
    ticketStrategy: text("ticket_strategy", { enum: ["any", "first", "second"] })
      .notNull()
      .default("any"),
    mode: text("mode", { enum: ["inspection", "live"] }).notNull(),
    status: text("status", { enum: ["draft", "armed", "stopped", "completed", "blocked"] })
      .notNull()
      .default("draft"),
    organizerOwned: integer("organizer_owned", { mode: "boolean" }).notNull().default(false),
    permissionConfirmed: integer("permission_confirmed", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_runs_owner_updated").on(table.ownerId, table.updatedAt)],
);

export const runDevices = sqliteTable(
  "run_devices",
  {
    runId: text("run_id").notNull(),
    deviceId: text("device_id").notNull(),
    role: text("role", { enum: ["primary", "standby", "inspection"] }).notNull(),
    status: text("status").notNull().default("pending"),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.deviceId] }),
    index("idx_run_devices_device").on(table.deviceId),
  ],
);

export const commands = sqliteTable(
  "commands",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    deviceId: text("device_id").notNull(),
    runId: text("run_id"),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    status: text("status", { enum: ["queued", "delivered", "acknowledged", "failed"] })
      .notNull()
      .default("queued"),
    createdAt: integer("created_at").notNull(),
    deliveredAt: integer("delivered_at"),
    acknowledgedAt: integer("acknowledged_at"),
  },
  (table) => [index("idx_commands_device_status_created").on(table.deviceId, table.status, table.createdAt)],
);

export const leases = sqliteTable(
  "leases",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    runId: text("run_id").notNull(),
    deviceId: text("device_id").notNull(),
    status: text("status", { enum: ["offered", "active", "submitted", "released", "blocked"] })
      .notNull()
      .default("offered"),
    createdAt: integer("created_at").notNull(),
    activatedAt: integer("activated_at"),
    completedAt: integer("completed_at"),
  },
  (table) => [
    uniqueIndex("idx_leases_run").on(table.runId),
    index("idx_leases_device_status").on(table.deviceId, table.status),
  ],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    runId: text("run_id"),
    deviceId: text("device_id"),
    source: text("source").notNull(),
    action: text("action").notNull(),
    detailJson: text("detail_json").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_audit_owner_created").on(table.ownerId, table.createdAt)],
);

export const pinLoginAttempts = sqliteTable(
  "pin_login_attempts",
  {
    clientHash: text("client_hash").primaryKey(),
    failures: integer("failures").notNull().default(0),
    windowStartedAt: integer("window_started_at").notNull(),
    blockedUntil: integer("blocked_until"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_pin_attempts_updated").on(table.updatedAt)],
);
