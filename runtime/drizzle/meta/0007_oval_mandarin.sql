ALTER TABLE `action_log` ADD `tc_tool_call_count` integer;--> statement-breakpoint
ALTER TABLE `action_log` ADD `tc_budget_exhausted` integer;--> statement-breakpoint
ALTER TABLE `action_log` ADD `tc_afterward` text;--> statement-breakpoint
ALTER TABLE `action_log` ADD `tc_command_log` text;