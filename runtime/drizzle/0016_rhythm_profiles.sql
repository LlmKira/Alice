CREATE TABLE `rhythm_profiles` (
	`entity_id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`source_window_start_ms` integer NOT NULL,
	`source_window_end_ms` integer NOT NULL,
	`sample_count` integer NOT NULL,
	`bucket_count` integer NOT NULL,
	`active_now_score` real NOT NULL,
	`quiet_now_score` real NOT NULL,
	`unusual_activity_score` real NOT NULL,
	`peak_windows_json` text DEFAULT '[]' NOT NULL,
	`quiet_windows_json` text DEFAULT '[]' NOT NULL,
	`confidence` text NOT NULL,
	`stale` integer DEFAULT false NOT NULL,
	`diagnostics_json` text DEFAULT '{}' NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_rhythm_profiles_type` ON `rhythm_profiles` (`entity_type`);
--> statement-breakpoint
CREATE INDEX `idx_rhythm_profiles_confidence` ON `rhythm_profiles` (`confidence`);
--> statement-breakpoint
CREATE INDEX `idx_rhythm_profiles_updated` ON `rhythm_profiles` (`updated_at_ms`);
