CREATE TABLE `risk_assessments` (
	`transaction_id` text,
	`trace_id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`approved` integer NOT NULL,
	`max_quantity` real NOT NULL,
	`rejection_gate` text,
	`account_equity` real,
	`buying_power` real,
	`reasoning` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `risk_gate_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trace_id` text NOT NULL,
	`gate_name` text NOT NULL,
	`sequence` integer NOT NULL,
	`passed` integer NOT NULL,
	`detail` text
);
