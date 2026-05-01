ALTER TABLE `message_log` ADD `platform` text DEFAULT 'telegram' NOT NULL;--> statement-breakpoint
ALTER TABLE `message_log` ADD `native_chat_id` text;--> statement-breakpoint
ALTER TABLE `message_log` ADD `native_msg_id` text;--> statement-breakpoint
ALTER TABLE `message_log` ADD `stable_message_id` text;--> statement-breakpoint
UPDATE `message_log`
SET
  `native_chat_id` = replace(`chat_id`, 'channel:telegram:', ''),
  `native_msg_id` = CASE WHEN `msg_id` IS NULL THEN NULL ELSE CAST(`msg_id` AS text) END,
  `stable_message_id` = CASE
    WHEN `msg_id` IS NULL THEN NULL
    ELSE 'message:telegram:' || replace(`chat_id`, 'channel:telegram:', '') || ':' || CAST(`msg_id` AS text)
  END
WHERE `platform` = 'telegram';--> statement-breakpoint
CREATE INDEX `idx_message_log_platform_native` ON `message_log` (`platform`,`native_chat_id`,`native_msg_id`);--> statement-breakpoint
CREATE INDEX `idx_message_log_stable_message` ON `message_log` (`stable_message_id`);
