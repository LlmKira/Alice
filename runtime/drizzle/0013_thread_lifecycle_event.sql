CREATE TABLE `thread_lifecycle_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_node_id` text NOT NULL,
	`thread_id` integer,
	`tick` integer NOT NULL,
	`occurred_at_ms` integer NOT NULL,
	`previous_status` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text NOT NULL,
	`deadline_ms` integer,
	`snooze_until_ms` integer,
	`p4_before` real,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_thread_lifecycle_event_thread` ON `thread_lifecycle_event` (`thread_node_id`);
--> statement-breakpoint
CREATE INDEX `idx_thread_lifecycle_event_outcome` ON `thread_lifecycle_event` (`outcome`);
--> statement-breakpoint
CREATE INDEX `idx_thread_lifecycle_event_tick` ON `thread_lifecycle_event` (`tick`);
