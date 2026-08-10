CREATE TABLE `consensus_decisions` (
	`transaction_id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`weighted_confidence` real NOT NULL,
	`threshold` real NOT NULL,
	`approved` integer NOT NULL,
	`agreements_count` integer DEFAULT 0 NOT NULL,
	`disagreements_count` integer DEFAULT 0 NOT NULL,
	`debate_used` integer DEFAULT false,
	`debate_provider_count` integer,
	`reasoning` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `consensus_evidence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transaction_id` text NOT NULL,
	`source_trace_id` text,
	`agent` text NOT NULL,
	`side` text NOT NULL,
	`confidence` real NOT NULL,
	`weight` real NOT NULL,
	`reasoning` text,
	`agreed` integer NOT NULL,
	`current_price` real
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`opened_at` text NOT NULL,
	`closed_at` text,
	`status` text NOT NULL,
	`final_decision` text,
	`outcome` text DEFAULT 'PENDING'
);
--> statement-breakpoint
ALTER TABLE `event_traces` ADD `transaction_id` text;
