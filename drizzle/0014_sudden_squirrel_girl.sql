CREATE TABLE `training_examples` (
	`id` text PRIMARY KEY NOT NULL,
	`transaction_id` text NOT NULL,
	`observed_at` text NOT NULL,
	`available_at` text NOT NULL,
	`decision_at` text NOT NULL,
	`feature_snapshot` text NOT NULL,
	`label` text NOT NULL,
	`created_at` text NOT NULL
);
