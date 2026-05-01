CREATE TABLE `decision_trace` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `tick` integer NOT NULL,
  `phase` text NOT NULL,
  `target` text,
  `action_log_id` integer,
  `final_decision` text NOT NULL,
  `reason` text NOT NULL,
  `payload_json` text DEFAULT '{}' NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_decision_trace_tick` ON `decision_trace` (`tick`);
--> statement-breakpoint
CREATE INDEX `idx_decision_trace_action_log` ON `decision_trace` (`action_log_id`);
--> statement-breakpoint
CREATE INDEX `idx_decision_trace_phase_tick` ON `decision_trace` (`phase`,`tick`);
