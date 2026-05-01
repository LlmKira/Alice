CREATE TABLE `emotion_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`kind` text NOT NULL,
	`valence` real NOT NULL,
	`arousal` real NOT NULL,
	`intensity` real NOT NULL,
	`target_id` text,
	`cause_type` text NOT NULL,
	`cause_json` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`half_life_ms` integer NOT NULL,
	`confidence` real NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_emotion_events_event` ON `emotion_events` (`event_id`);
--> statement-breakpoint
CREATE INDEX `idx_emotion_events_created` ON `emotion_events` (`created_at_ms`);
--> statement-breakpoint
CREATE INDEX `idx_emotion_events_kind_created` ON `emotion_events` (`kind`,`created_at_ms`);
--> statement-breakpoint
CREATE INDEX `idx_emotion_events_target_created` ON `emotion_events` (`target_id`,`created_at_ms`);
