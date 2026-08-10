CREATE TABLE `escalation_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` text NOT NULL,
	`trace_id` text,
	`agent` text NOT NULL,
	`task` text NOT NULL,
	`local_source` text NOT NULL,
	`local_signal_available` integer NOT NULL,
	`local_confidence` real,
	`decisive_threshold` real NOT NULL,
	`escalated` integer NOT NULL,
	`reason` text NOT NULL,
	`escalated_provider` text
);
