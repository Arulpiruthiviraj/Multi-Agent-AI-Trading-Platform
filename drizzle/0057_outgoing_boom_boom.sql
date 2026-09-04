ALTER TABLE `research_agent_runs` ADD `trigger_type` text;--> statement-breakpoint
ALTER TABLE `research_agent_runs` ADD `trigger_reason` text;--> statement-breakpoint
ALTER TABLE `research_agent_runs` ADD `trigger_event_id` text;--> statement-breakpoint
ALTER TABLE `research_agent_runs` ADD `evidence_snapshot_json` text;--> statement-breakpoint
CREATE INDEX `idx_research_agent_runs_trigger_event` ON `research_agent_runs` (`trigger_event_id`);
