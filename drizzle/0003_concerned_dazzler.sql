DROP INDEX `idx_leases_run`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_leases_run_device` ON `leases` (`run_id`,`device_id`);