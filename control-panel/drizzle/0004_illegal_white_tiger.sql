ALTER TABLE `devices` ADD `approval_status` text DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE `pairing_codes` ADD `max_uses` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `pairing_codes` ADD `used_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pairing_codes` ADD `approval_required` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `pairing_codes` SET `used_count` = `max_uses` WHERE `used_at` IS NOT NULL AND `used_count` = 0;
