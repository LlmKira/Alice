ALTER TABLE `social_events` ADD `case_id` text;
--> statement-breakpoint
CREATE INDEX `idx_social_events_case_time` ON `social_events` (`case_id`,`occurred_at_ms`);
