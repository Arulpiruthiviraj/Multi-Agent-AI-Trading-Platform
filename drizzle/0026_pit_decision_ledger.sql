CREATE TABLE `pit_decision_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`as_of_ms` integer NOT NULL,
	`published_at_ms` integer NOT NULL,
	`symbol` text NOT NULL,
	`kind` text NOT NULL,
	`agent` text,
	`side` text,
	`confidence` real,
	`finbert_score` real,
	`impact_score` real,
	`payload_json` text,
	`source` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pit_decision_ledger_asof` ON `pit_decision_ledger` (`as_of_ms`);
--> statement-breakpoint
CREATE INDEX `idx_pit_decision_ledger_published` ON `pit_decision_ledger` (`published_at_ms`);
--> statement-breakpoint
CREATE INDEX `idx_pit_decision_ledger_symbol` ON `pit_decision_ledger` (`symbol`);
