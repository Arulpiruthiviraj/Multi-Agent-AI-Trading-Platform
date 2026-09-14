CREATE TABLE `consensus_debate_predictions` (
	`id` text PRIMARY KEY NOT NULL,
	`trace_id` text NOT NULL,
	`symbol` text NOT NULL,
	`created_at` text NOT NULL,
	`debate_status` text NOT NULL,
	`debate_direction` text,
	`debate_confidence` real,
	`providers_attempted` integer DEFAULT 0 NOT NULL,
	`providers_succeeded` integer DEFAULT 0 NOT NULL,
	`providers_failed` integer DEFAULT 0 NOT NULL,
	`underlying_agent_count` integer NOT NULL,
	`underlying_evidence_json` text NOT NULL,
	`base_consensus_side` text NOT NULL,
	`base_consensus_confidence` real NOT NULL,
	`base_clears_threshold` integer NOT NULL,
	`base_clears_independence` integer NOT NULL,
	`with_debate_consensus_side` text NOT NULL,
	`with_debate_consensus_confidence` real NOT NULL,
	`with_debate_approved` integer NOT NULL,
	`veto_fired` integer NOT NULL,
	`market_regime` text
);
--> statement-breakpoint
CREATE INDEX `idx_consensus_debate_predictions_trace` ON `consensus_debate_predictions` (`trace_id`);--> statement-breakpoint
CREATE INDEX `idx_consensus_debate_predictions_symbol` ON `consensus_debate_predictions` (`symbol`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_consensus_debate_predictions_status` ON `consensus_debate_predictions` (`debate_status`);
