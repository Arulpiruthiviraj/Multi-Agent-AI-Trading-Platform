CREATE TABLE `agent_reasoning_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trace_id` text NOT NULL,
	`timestamp` text NOT NULL,
	`agent_name` text NOT NULL,
	`symbol` text NOT NULL,
	`action` text NOT NULL,
	`confidence` real NOT NULL,
	`indicators_snapshot` text,
	`prompt_context` text,
	`reasoning_summary` text NOT NULL,
	`execution_latency_ms` real
);
--> statement-breakpoint
CREATE INDEX `idx_agent_reasoning_logs_trace_id` ON `agent_reasoning_logs` (`trace_id`);
--> statement-breakpoint
CREATE INDEX `idx_agent_reasoning_logs_symbol` ON `agent_reasoning_logs` (`symbol`, `timestamp`);
--> statement-breakpoint
CREATE TABLE `transaction_traces` (
	`trace_id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`created_at` text NOT NULL,
	`lifecycle_status` text NOT NULL,
	`contributing_agents` text,
	`consensus_score` real,
	`consensus_threshold` real,
	`risk_summary` text,
	`terminal_reason` text,
	`order_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_transaction_traces_symbol` ON `transaction_traces` (`symbol`, `created_at`);
--> statement-breakpoint
CREATE INDEX `idx_transaction_traces_status` ON `transaction_traces` (`lifecycle_status`, `created_at`);
