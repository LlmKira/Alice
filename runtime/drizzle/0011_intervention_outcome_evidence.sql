CREATE TABLE `intervention_outcome_evidence` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `tick` integer,
  `channel_id` text NOT NULL,
  `alice_message_log_id` integer NOT NULL,
  `alice_msg_id` integer,
  `alice_message_at_ms` integer NOT NULL,
  `evaluated_at_ms` integer NOT NULL,
  `outcome` text NOT NULL,
  `signal` real,
  `after_message_count` integer NOT NULL,
  `reply_to_alice_count` integer NOT NULL,
  `hostile_match_count` integer NOT NULL,
  `source_message_log_ids_json` text DEFAULT '[]' NOT NULL,
  `previous_reception` real,
  `next_reception` real,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_intervention_outcome_evidence_alice_message_log` ON `intervention_outcome_evidence` (`alice_message_log_id`);
--> statement-breakpoint
CREATE INDEX `idx_intervention_outcome_evidence_channel_time` ON `intervention_outcome_evidence` (`channel_id`,`alice_message_at_ms`);
--> statement-breakpoint
CREATE INDEX `idx_intervention_outcome_evidence_outcome` ON `intervention_outcome_evidence` (`outcome`);
