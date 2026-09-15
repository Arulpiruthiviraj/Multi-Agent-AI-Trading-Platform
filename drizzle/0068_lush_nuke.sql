CREATE INDEX `idx_agent_predictions_timestamp` ON `agent_predictions` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_kronos_predictions_timestamp` ON `kronos_predictions` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_news_predictions_created_at` ON `news_predictions` (`created_at`);
