CREATE TABLE `focus_transition_shadow` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transition_shadow_id` text NOT NULL,
	`tick` integer NOT NULL,
	`action_id` text NOT NULL,
	`action_log_id` integer,
	`candidate_id` text,
	`source_target` text,
	`current_chat_id` text NOT NULL,
	`requested_chat_id` text NOT NULL,
	`source_command` text NOT NULL,
	`transition_class` text NOT NULL,
	`evidence_status` text DEFAULT 'structured_requested_target' NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_focus_transition_shadow_id` ON `focus_transition_shadow` (`transition_shadow_id`);
--> statement-breakpoint
CREATE INDEX `idx_focus_transition_shadow_action` ON `focus_transition_shadow` (`action_id`);
--> statement-breakpoint
CREATE INDEX `idx_focus_transition_shadow_requested` ON `focus_transition_shadow` (`requested_chat_id`);
--> statement-breakpoint
CREATE INDEX `idx_focus_transition_shadow_tick` ON `focus_transition_shadow` (`tick`);
