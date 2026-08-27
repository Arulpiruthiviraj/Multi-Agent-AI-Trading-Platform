CREATE TABLE `learning_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`observation_type` text NOT NULL,
	`trust_level` text NOT NULL,
	`evidence_json` text NOT NULL,
	`outcome_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_learning_observations_type` ON `learning_observations` (`observation_type`,`created_at`);--> statement-breakpoint
CREATE TABLE `learning_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`version_type` text NOT NULL,
	`parent_version_id` text,
	`status` text NOT NULL,
	`state_json` text NOT NULL,
	`hypothesis` text,
	`evidence_json` text,
	`sample_size` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`promoted_at` text,
	`retired_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_learning_versions_type` ON `learning_versions` (`version_type`,`status`);--> statement-breakpoint
CREATE TABLE `missed_opportunities` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`detected_at` text NOT NULL,
	`classification` text NOT NULL,
	`classification_reason` text NOT NULL,
	`evidence_at_decision_json` text NOT NULL,
	`price_at_detection` real,
	`evaluation_horizon_minutes` integer NOT NULL,
	`evaluation_status` text NOT NULL,
	`price_at_evaluation` real,
	`max_favorable_excursion_pct` real,
	`max_adverse_excursion_pct` real,
	`evaluated_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_missed_opportunities_symbol` ON `missed_opportunities` (`symbol`,`detected_at`);--> statement-breakpoint
CREATE INDEX `idx_missed_opportunities_status` ON `missed_opportunities` (`evaluation_status`);--> statement-breakpoint
CREATE TABLE `promotion_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version_id` text NOT NULL,
	`decision` text NOT NULL,
	`reason` text NOT NULL,
	`metrics_json` text NOT NULL,
	`decided_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_promotion_decisions_version` ON `promotion_decisions` (`version_id`);--> statement-breakpoint
CREATE TABLE `rollback_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version_type` text NOT NULL,
	`from_version_id` text NOT NULL,
	`to_version_id` text NOT NULL,
	`reason` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_rollback_events_type` ON `rollback_events` (`version_type`,`created_at`);
