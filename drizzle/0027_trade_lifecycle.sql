CREATE TABLE `trade_lifecycle_transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`symbol` text NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`source` text,
	`evidence_json` text,
	`latency_ms` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_trade_lifecycle_candidate` ON `trade_lifecycle_transitions` (`candidate_id`);
--> statement-breakpoint
CREATE INDEX `idx_trade_lifecycle_created` ON `trade_lifecycle_transitions` (`created_at`);
