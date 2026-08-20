CREATE TABLE `news_predictions` (
	`id` text PRIMARY KEY NOT NULL,
	`cluster_id` text NOT NULL,
	`trace_id` text NOT NULL,
	`symbol` text NOT NULL,
	`created_at` text NOT NULL,
	`direction` text NOT NULL,
	`confidence` real NOT NULL,
	`expected_horizon` text NOT NULL,
	`reference_price` real,
	`reasoning` text,
	`materiality` text,
	`catalyst_type` text,
	`risk_level` text,
	`risk_veto` integer DEFAULT false,
	`source_count` integer DEFAULT 1,
	`news_agent_mode` text NOT NULL,
	`model_source` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_news_predictions_symbol` ON `news_predictions` (`symbol`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_news_predictions_cluster` ON `news_predictions` (`cluster_id`);
