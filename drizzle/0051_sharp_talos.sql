CREATE TABLE `trade_plan_revalidations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plan_id` text NOT NULL,
	`revalidated_at` text NOT NULL,
	`result` text NOT NULL,
	`reason` text NOT NULL,
	`price_at_revalidation` real
);
--> statement-breakpoint
CREATE INDEX `idx_trade_plan_revalidations_plan` ON `trade_plan_revalidations` (`plan_id`,`revalidated_at`);--> statement-breakpoint
CREATE TABLE `trade_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`plan_date` text NOT NULL,
	`setup_type` text NOT NULL,
	`direction` text NOT NULL,
	`thesis` text NOT NULL,
	`catalysts` text,
	`entry_zone_low` real,
	`entry_zone_high` real,
	`invalidation_level` real,
	`target_concept` text,
	`confidence` real NOT NULL,
	`evidence_quality` real NOT NULL,
	`rank_at_creation` integer,
	`component_scores_json` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`valid_until` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_trade_plans_plan_date` ON `trade_plans` (`plan_date`,`setup_type`);--> statement-breakpoint
CREATE INDEX `idx_trade_plans_symbol` ON `trade_plans` (`symbol`,`created_at`);
