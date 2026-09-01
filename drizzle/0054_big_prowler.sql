DROP INDEX `idx_agent_confidence_calibration_bucket`;--> statement-breakpoint
ALTER TABLE `agent_confidence_calibration` ADD `provider` text DEFAULT 'ALL' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_confidence_calibration_bucket` ON `agent_confidence_calibration` (`agent_name`,`bucket_low`,`provider`);
