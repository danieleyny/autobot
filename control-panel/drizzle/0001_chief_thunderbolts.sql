CREATE TABLE `pin_login_attempts` (
	`client_hash` text PRIMARY KEY NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`window_started_at` integer NOT NULL,
	`blocked_until` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pin_attempts_updated` ON `pin_login_attempts` (`updated_at`);