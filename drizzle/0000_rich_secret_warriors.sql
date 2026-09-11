CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`run_id` text,
	`device_id` text,
	`source` text NOT NULL,
	`action` text NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_owner_created` ON `audit_events` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `commands` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`device_id` text NOT NULL,
	`run_id` text,
	`type` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	`acknowledged_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_commands_device_status_created` ON `commands` (`device_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`version` text DEFAULT 'unknown' NOT NULL,
	`mode` text DEFAULT 'local' NOT NULL,
	`state_json` text DEFAULT '{}' NOT NULL,
	`last_seen_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_devices_token_hash` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_devices_owner_last_seen` ON `devices` (`owner_id`,`last_seen_at`);--> statement-breakpoint
CREATE TABLE `leases` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`run_id` text NOT NULL,
	`device_id` text NOT NULL,
	`status` text DEFAULT 'offered' NOT NULL,
	`created_at` integer NOT NULL,
	`activated_at` integer,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_leases_run` ON `leases` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_leases_device_status` ON `leases` (`device_id`,`status`);--> statement-breakpoint
CREATE TABLE `pairing_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`label` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pairing_owner_expires` ON `pairing_codes` (`owner_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `run_devices` (
	`run_id` text NOT NULL,
	`device_id` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	PRIMARY KEY(`run_id`, `device_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_run_devices_device` ON `run_devices` (`device_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`event_url` text NOT NULL,
	`event_title` text NOT NULL,
	`release_at` integer NOT NULL,
	`ticket_strategy` text DEFAULT 'any' NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`organizer_owned` integer DEFAULT false NOT NULL,
	`permission_confirmed` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_runs_owner_updated` ON `runs` (`owner_id`,`updated_at`);