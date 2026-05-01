CREATE TABLE `social_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`target_id` text,
	`affected_relation_a` text NOT NULL,
	`affected_relation_b` text NOT NULL,
	`affected_relation_key` text NOT NULL,
	`venue_id` text NOT NULL,
	`visibility` text NOT NULL,
	`witnesses_json` text DEFAULT '[]' NOT NULL,
	`severity` real NOT NULL,
	`confidence` real NOT NULL,
	`evidence_msg_ids_json` text DEFAULT '[]' NOT NULL,
	`causes_json` text DEFAULT '[]' NOT NULL,
	`occurred_at_ms` integer NOT NULL,
	`repairs_event_id` text,
	`boundary_text` text,
	`content_text` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_social_events_event` ON `social_events` (`event_id`);
--> statement-breakpoint
CREATE INDEX `idx_social_events_relation_time` ON `social_events` (`affected_relation_key`,`occurred_at_ms`);
--> statement-breakpoint
CREATE INDEX `idx_social_events_kind` ON `social_events` (`kind`);
--> statement-breakpoint
CREATE INDEX `idx_social_events_venue_time` ON `social_events` (`venue_id`,`occurred_at_ms`);
