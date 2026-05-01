CREATE TABLE `focus_transition_intent` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`intent_id` text NOT NULL,
	`tick` integer NOT NULL,
	`source_chat_id` text NOT NULL,
	`requested_chat_id` text NOT NULL,
	`intent_kind` text NOT NULL,
	`reason` text NOT NULL,
	`source_command` text DEFAULT 'self.attention-pull' NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_focus_transition_intent_id` ON `focus_transition_intent` (`intent_id`);
--> statement-breakpoint
CREATE INDEX `idx_focus_transition_intent_requested` ON `focus_transition_intent` (`requested_chat_id`);
--> statement-breakpoint
CREATE INDEX `idx_focus_transition_intent_tick` ON `focus_transition_intent` (`tick`);
