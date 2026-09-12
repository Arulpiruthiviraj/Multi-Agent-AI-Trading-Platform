CREATE TABLE `research_experiments` (
	`id` text PRIMARY KEY NOT NULL,
	`hypothesis_id` text,
	`strategy_id` text,
	`dataset_hash` text,
	`label` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text,
	`result_summary_json` text
);
--> statement-breakpoint
CREATE INDEX `idx_research_experiments_hypothesis` ON `research_experiments` (`hypothesis_id`);--> statement-breakpoint
CREATE INDEX `idx_research_experiments_strategy` ON `research_experiments` (`strategy_id`);--> statement-breakpoint
CREATE TABLE `research_hypotheses` (
	`id` text PRIMARY KEY NOT NULL,
	`statement` text NOT NULL,
	`strategy_id` text,
	`metric` text,
	`expected_direction` text,
	`acceptance_criteria` text,
	`preregistered_at` text NOT NULL,
	`created_by` text,
	`resolved_at` text,
	`resolved_status` text,
	`resolved_evidence_json` text
);
--> statement-breakpoint
CREATE INDEX `idx_research_hypotheses_strategy` ON `research_hypotheses` (`strategy_id`);--> statement-breakpoint
CREATE TABLE `research_trials` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_id` text,
	`strategy_id` text NOT NULL,
	`dataset_hash` text NOT NULL,
	`parameter_set_json` text,
	`evaluation_timestamp` text NOT NULL,
	`in_sample_metrics_json` text,
	`out_of_sample_metrics_json` text,
	`rejection_reason` text,
	`selection_status` text NOT NULL,
	`symbol` text,
	`dataset_period_start` text,
	`dataset_period_end` text,
	`execution_model` text,
	`transaction_cost_assumptions_json` text,
	`slippage_assumptions_json` text,
	`wfo_config_json` text,
	`oos_config_json` text,
	`robustness_config_json` text,
	`parent_trial_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_research_trials_experiment` ON `research_trials` (`experiment_id`);--> statement-breakpoint
CREATE INDEX `idx_research_trials_strategy` ON `research_trials` (`strategy_id`,`evaluation_timestamp`);
