CREATE TABLE `fills` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` text NOT NULL,
	`broker_fill_id` text,
	`quantity` real NOT NULL,
	`price` real NOT NULL,
	`filled_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `portfolio_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`quantity` real NOT NULL,
	`average_price` real,
	`current_price` real,
	`source` text NOT NULL,
	`snapshot_at` text NOT NULL,
	`reconciliation_id` integer
);
--> statement-breakpoint
CREATE TABLE `reconciliation_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`checked_at` text NOT NULL,
	`broker` text NOT NULL,
	`matches` integer NOT NULL,
	`mismatches` text,
	`worst_impact_dollars` real,
	`action_taken` text
);
--> statement-breakpoint
ALTER TABLE `trades` ADD `transaction_id` text;
--> statement-breakpoint
ALTER TABLE `trades` ADD `broker_order_id` text;
--> statement-breakpoint
ALTER TABLE `trades` ADD `request_id` text;
--> statement-breakpoint
ALTER TABLE `trades` ADD `submitted_at` text;
--> statement-breakpoint
ALTER TABLE `trades` ADD `accepted_at` text;
--> statement-breakpoint
ALTER TABLE `trades` ADD `filled_at` text;
