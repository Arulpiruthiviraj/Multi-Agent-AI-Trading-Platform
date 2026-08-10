CREATE TABLE `ai_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`trace_id` text,
	`transaction_id` text,
	`agent` text NOT NULL,
	`provider` text NOT NULL,
	`model` text,
	`model_version` text,
	`prompt_version` text,
	`prompt` text,
	`raw_response` text,
	`parsed_response` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`cost` real,
	`latency_ms` real,
	`status` text NOT NULL,
	`error` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `agent_predictions` ADD `trace_id` text;
--> statement-breakpoint
ALTER TABLE `agent_predictions` ADD `ai_call_id` text;
--> statement-breakpoint
ALTER TABLE `agent_predictions` ADD `provider` text;
--> statement-breakpoint
ALTER TABLE `agent_predictions` ADD `latency_ms` real;
