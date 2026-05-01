CREATE TABLE `album_photos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`asset_id` text NOT NULL,
	`file_unique_id` text NOT NULL,
	`source_chat_id` integer NOT NULL,
	`source_msg_id` integer NOT NULL,
	`media_type` text DEFAULT 'photo' NOT NULL,
	`caption_text` text,
	`description` text,
	`wd_tags_json` text,
	`ocr_text` text,
	`visibility_scope` text DEFAULT 'group' NOT NULL,
	`source_status` text DEFAULT 'available' NOT NULL,
	`last_failure_code` text,
	`observed_at_ms` integer NOT NULL,
	`last_indexed_at_ms` integer NOT NULL,
	`source_missing_at_ms` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_album_photos_asset` ON `album_photos` (`asset_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_album_photos_file_unique` ON `album_photos` (`file_unique_id`);
--> statement-breakpoint
CREATE INDEX `idx_album_photos_source` ON `album_photos` (`source_chat_id`,`source_msg_id`);
--> statement-breakpoint
CREATE INDEX `idx_album_photos_status` ON `album_photos` (`source_status`);
--> statement-breakpoint
CREATE INDEX `idx_album_photos_observed` ON `album_photos` (`observed_at_ms`);
--> statement-breakpoint
CREATE TABLE `album_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`asset_id` text NOT NULL,
	`target_chat_id` integer NOT NULL,
	`action_log_id` integer,
	`sent_msg_id` integer,
	`send_mode` text NOT NULL,
	`failure_code` text,
	`used_at_ms` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_album_usage_asset` ON `album_usage` (`asset_id`);
--> statement-breakpoint
CREATE INDEX `idx_album_usage_target` ON `album_usage` (`target_chat_id`);
--> statement-breakpoint
CREATE INDEX `idx_album_usage_used` ON `album_usage` (`used_at_ms`);
--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS album_photo_fts USING fts5(
  search_text,
  tokenize='better_trigram'
);
--> statement-breakpoint
CREATE TRIGGER album_photos_ai AFTER INSERT ON album_photos BEGIN
  INSERT INTO album_photo_fts(rowid, search_text)
  VALUES (
    new.id,
    coalesce(new.caption_text, '') || ' ' ||
    coalesce(new.description, '') || ' ' ||
    coalesce(new.wd_tags_json, '') || ' ' ||
    coalesce(new.ocr_text, '')
  );
END;
--> statement-breakpoint
CREATE TRIGGER album_photos_ad AFTER DELETE ON album_photos BEGIN
  DELETE FROM album_photo_fts WHERE rowid = old.id;
END;
--> statement-breakpoint
CREATE TRIGGER album_photos_au AFTER UPDATE OF caption_text, description, wd_tags_json, ocr_text ON album_photos BEGIN
  DELETE FROM album_photo_fts WHERE rowid = old.id;
  INSERT INTO album_photo_fts(rowid, search_text)
  VALUES (
    new.id,
    coalesce(new.caption_text, '') || ' ' ||
    coalesce(new.description, '') || ' ' ||
    coalesce(new.wd_tags_json, '') || ' ' ||
    coalesce(new.ocr_text, '')
  );
END;
