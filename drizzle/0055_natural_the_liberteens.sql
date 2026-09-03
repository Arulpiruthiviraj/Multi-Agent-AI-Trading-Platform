CREATE TABLE `research_agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`correlation_id` text NOT NULL,
	`kind` text NOT NULL,
	`strategy_id` text,
	`request_json` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text,
	`error_message` text,
	`graph_version` text,
	`provider_model` text,
	`duration_ms` integer,
	`created_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_research_agent_runs_correlation` ON `research_agent_runs` (`correlation_id`);--> statement-breakpoint
CREATE INDEX `idx_research_agent_runs_strategy` ON `research_agent_runs` (`strategy_id`,`created_at`);
