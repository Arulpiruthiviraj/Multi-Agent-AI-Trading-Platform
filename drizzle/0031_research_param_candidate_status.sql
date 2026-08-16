CREATE TABLE IF NOT EXISTS `strategy_configurations_new` (
	`id` text PRIMARY KEY NOT NULL,
	`strategy_id` text NOT NULL,
	`regime` text NOT NULL,
	`params_json` text NOT NULL,
	`status` text NOT NULL,
	`ev_oos` real,
	`dsr_train` real,
	`permutation_pass` integer NOT NULL,
	`dataset_id` text,
	`full_strategy_parity` integer NOT NULL DEFAULT 0,
	`updated_at` text NOT NULL,
	CHECK (`status` IN ('RESEARCH_PARAM_CANDIDATE', 'PAPER_TESTING'))
);
--> statement-breakpoint
INSERT OR IGNORE INTO `strategy_configurations_new`
SELECT
  `id`, `strategy_id`, `regime`, `params_json`,
  CASE WHEN `status` = 'PAPER_TESTING' THEN 'RESEARCH_PARAM_CANDIDATE' ELSE `status` END,
  `ev_oos`, `dsr_train`, `permutation_pass`, `dataset_id`, `full_strategy_parity`, `updated_at`
FROM `strategy_configurations`;
--> statement-breakpoint
DROP TABLE IF EXISTS `strategy_configurations`;
--> statement-breakpoint
ALTER TABLE `strategy_configurations_new` RENAME TO `strategy_configurations`;
