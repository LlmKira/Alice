CREATE TABLE `action_result` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`action_id` text NOT NULL,
	`tick` integer NOT NULL,
	`enqueue_id` text,
	`candidate_id` text,
	`action_log_id` integer,
	`target_namespace` text NOT NULL,
	`target_id` text,
	`action_type` text NOT NULL,
	`result` text NOT NULL,
	`failure_code` text NOT NULL,
	`external_message_id` text,
	`completed_action_refs_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_action_result_action` ON `action_result` (`action_id`);--> statement-breakpoint
CREATE INDEX `idx_action_result_enqueue` ON `action_result` (`enqueue_id`);--> statement-breakpoint
CREATE INDEX `idx_action_result_action_log` ON `action_result` (`action_log_id`);--> statement-breakpoint
CREATE INDEX `idx_action_result_result` ON `action_result` (`result`);--> statement-breakpoint
CREATE TABLE `candidate_trace` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`candidate_id` text NOT NULL,
	`tick` integer NOT NULL,
	`target_namespace` text NOT NULL,
	`target_id` text,
	`action_type` text NOT NULL,
	`normalized_considerations_json` text DEFAULT '{}' NOT NULL,
	`delta_p` real,
	`social_cost` real,
	`net_value` real,
	`bottleneck` text,
	`gate_plane` text NOT NULL,
	`selected` integer DEFAULT false NOT NULL,
	`candidate_rank` integer,
	`silence_reason` text NOT NULL,
	`retained_impulse_json` text,
	`sample_status` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_candidate_trace_candidate` ON `candidate_trace` (`candidate_id`);--> statement-breakpoint
CREATE INDEX `idx_candidate_trace_tick` ON `candidate_trace` (`tick`);--> statement-breakpoint
CREATE INDEX `idx_candidate_trace_silence` ON `candidate_trace` (`silence_reason`);--> statement-breakpoint
CREATE TABLE `fact_mutation` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mutation_id` text NOT NULL,
	`action_id` text,
	`source_tick` integer,
	`fact_namespace` text NOT NULL,
	`entity_namespace` text NOT NULL,
	`entity_id` text,
	`mutation_kind` text NOT NULL,
	`before_summary` text,
	`after_summary` text,
	`delta_json` text,
	`authority_table` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_fact_mutation_id` ON `fact_mutation` (`mutation_id`);--> statement-breakpoint
CREATE INDEX `idx_fact_mutation_action` ON `fact_mutation` (`action_id`);--> statement-breakpoint
CREATE INDEX `idx_fact_mutation_tick` ON `fact_mutation` (`source_tick`);--> statement-breakpoint
CREATE INDEX `idx_fact_mutation_kind` ON `fact_mutation` (`mutation_kind`);--> statement-breakpoint
CREATE TABLE `pressure_delta` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pressure_delta_id` text NOT NULL,
	`source_tick` integer NOT NULL,
	`related_candidate_id` text,
	`related_action_id` text,
	`window_start_tick` integer NOT NULL,
	`window_end_tick` integer NOT NULL,
	`window_size_ticks` integer NOT NULL,
	`pressure_before` real NOT NULL,
	`pressure_after` real NOT NULL,
	`dimension` text NOT NULL,
	`release_classification` text NOT NULL,
	`classification_reason` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pressure_delta_id` ON `pressure_delta` (`pressure_delta_id`);--> statement-breakpoint
CREATE INDEX `idx_pressure_delta_source` ON `pressure_delta` (`source_tick`);--> statement-breakpoint
CREATE INDEX `idx_pressure_delta_action` ON `pressure_delta` (`related_action_id`);--> statement-breakpoint
CREATE INDEX `idx_pressure_delta_dimension` ON `pressure_delta` (`dimension`);--> statement-breakpoint
CREATE TABLE `queue_trace` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`queue_trace_id` text NOT NULL,
	`tick` integer NOT NULL,
	`candidate_id` text NOT NULL,
	`enqueue_id` text NOT NULL,
	`enqueue_outcome` text NOT NULL,
	`fate` text NOT NULL,
	`queue_depth` integer,
	`active_count` integer,
	`saturation` real,
	`superseded_by_enqueue_id` text,
	`reason_code` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_queue_trace_event` ON `queue_trace` (`queue_trace_id`);--> statement-breakpoint
CREATE INDEX `idx_queue_trace_enqueue` ON `queue_trace` (`enqueue_id`);--> statement-breakpoint
CREATE INDEX `idx_queue_trace_candidate` ON `queue_trace` (`candidate_id`);--> statement-breakpoint
CREATE INDEX `idx_queue_trace_fate` ON `queue_trace` (`fate`);--> statement-breakpoint
CREATE TABLE `tick_trace` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tick` integer NOT NULL,
	`occurred_at_ms` integer NOT NULL,
	`pressure_vector_json` text NOT NULL,
	`scheduler_phase` text NOT NULL,
	`selected_candidate_id` text,
	`silence_marker` text,
	`sample_status` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tick_trace_tick` ON `tick_trace` (`tick`);--> statement-breakpoint
CREATE INDEX `idx_tick_trace_candidate` ON `tick_trace` (`selected_candidate_id`);--> statement-breakpoint
CREATE INDEX `idx_tick_trace_silence` ON `tick_trace` (`silence_marker`);
