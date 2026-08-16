CREATE TABLE `strategy_configurations` (
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
	CHECK (`status` = 'PAPER_TESTING')
);
