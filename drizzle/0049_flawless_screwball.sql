CREATE TABLE `strategy_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_candidate_id` text,
	`generation` integer NOT NULL,
	`source` text NOT NULL,
	`reason` text NOT NULL,
	`definition_json` text NOT NULL,
	`lifecycle_status` text NOT NULL,
	`champion_status` text DEFAULT 'NONE' NOT NULL,
	`rejection_reason` text,
	`evaluation_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_strategy_candidates_lifecycle` ON `strategy_candidates` (`lifecycle_status`);--> statement-breakpoint
CREATE INDEX `idx_strategy_candidates_parent` ON `strategy_candidates` (`parent_candidate_id`);--> statement-breakpoint
CREATE INDEX `idx_strategy_candidates_champion` ON `strategy_candidates` (`champion_status`);--> statement-breakpoint
CREATE TABLE `strategy_evolution_events` (
	`id` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`event_type` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`reason` text NOT NULL,
	`detail_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_strategy_evolution_events_candidate` ON `strategy_evolution_events` (`candidate_id`,`created_at`);
