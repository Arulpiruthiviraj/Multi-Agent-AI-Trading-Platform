ALTER TABLE `agent_predictions` ADD `regime` text;
--> statement-breakpoint
ALTER TABLE `agent_performance_stats` ADD `effective_predictions` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `agent_performance_stats` ADD `effective_correct` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `agent_performance_stats` ADD `wilson_lower` real;
--> statement-breakpoint
ALTER TABLE `agent_performance_stats` ADD `wilson_upper` real;
--> statement-breakpoint
ALTER TABLE `agent_performance_stats` ADD `evidence_status` text DEFAULT 'INSUFFICIENT_EVIDENCE' NOT NULL;
