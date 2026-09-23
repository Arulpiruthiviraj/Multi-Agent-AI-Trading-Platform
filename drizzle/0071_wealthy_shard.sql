CREATE INDEX `idx_event_traces_correlation` ON `event_traces` (`correlation_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_event_traces_trade` ON `event_traces` (`trade_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_event_traces_transaction` ON `event_traces` (`transaction_id`,`timestamp`);
