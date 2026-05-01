CREATE TABLE `emotion_repairs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repair_id` text NOT NULL,
	`repair_kind` text NOT NULL,
	`emotion_kind` text,
	`target_id` text,
	`strength` real NOT NULL,
	`cause_type` text NOT NULL,
	`cause_json` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`confidence` real NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_emotion_repairs_repair` ON `emotion_repairs` (`repair_id`);
--> statement-breakpoint
CREATE INDEX `idx_emotion_repairs_created` ON `emotion_repairs` (`created_at_ms`);
--> statement-breakpoint
CREATE INDEX `idx_emotion_repairs_kind_created` ON `emotion_repairs` (`repair_kind`,`created_at_ms`);
--> statement-breakpoint
CREATE INDEX `idx_emotion_repairs_target_created` ON `emotion_repairs` (`target_id`,`created_at_ms`);
