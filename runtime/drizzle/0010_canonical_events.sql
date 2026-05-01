CREATE TABLE `canonical_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `kind` text NOT NULL,
  `tick` integer NOT NULL,
  `occurred_at_ms` integer,
  `channel_id` text,
  `contact_id` text,
  `directed` integer DEFAULT false NOT NULL,
  `novelty` real,
  `source` text,
  `source_id` text,
  `payload_json` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_canonical_events_tick` ON `canonical_events` (`tick`);
--> statement-breakpoint
CREATE INDEX `idx_canonical_events_kind_tick` ON `canonical_events` (`kind`,`tick`);
--> statement-breakpoint
CREATE INDEX `idx_canonical_events_channel_tick` ON `canonical_events` (`channel_id`,`tick`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_canonical_events_source` ON `canonical_events` (`source`,`source_id`);
