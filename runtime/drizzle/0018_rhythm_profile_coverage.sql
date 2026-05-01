ALTER TABLE `rhythm_profiles` ADD `active_bucket_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rhythm_profiles` ADD `observed_span_hours` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rhythm_profiles` ADD `observed_days` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rhythm_profiles` ADD `timezone_offset_hours` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rhythm_profiles` ADD `enabled_periods_json` text DEFAULT '[]' NOT NULL;
