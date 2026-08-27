CREATE TABLE `candidate_rankings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`cycle_at` text NOT NULL,
	`momentum_score` real,
	`relative_volume_score` real,
	`range_expansion_score` real,
	`gap_score` real,
	`liquidity_score` real,
	`news_catalyst_score` real,
	`agent_confidence_score` real,
	`component_availability` text NOT NULL,
	`weights_used` text NOT NULL,
	`final_score` real NOT NULL,
	`rank` integer NOT NULL,
	`previous_rank` integer,
	`rank_delta` integer,
	`promotion_recommendation` text NOT NULL,
	`promotion_reason` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_candidate_rankings_symbol` ON `candidate_rankings` (`symbol`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_candidate_rankings_cycle` ON `candidate_rankings` (`cycle_at`);