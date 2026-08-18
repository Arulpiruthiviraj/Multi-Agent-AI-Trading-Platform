CREATE TABLE IF NOT EXISTS `observability_events` (
  `id` text PRIMARY KEY NOT NULL,
  `ts` integer NOT NULL,
  `level` text NOT NULL,
  `category` text NOT NULL,
  `event_type` text,
  `logger_name` text NOT NULL,
  `message` text NOT NULL,
  `session_id` text NOT NULL,
  `correlation_id` text,
  `decision_id` text,
  `trace_id` text,
  `order_id` text,
  `symbol` text,
  `component` text,
  `payload` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_observability_events_decision` ON `observability_events` (`decision_id`,`ts`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_observability_events_order` ON `observability_events` (`order_id`,`ts`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_observability_events_ts` ON `observability_events` (`ts`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_observability_events_category` ON `observability_events` (`category`,`ts`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_observability_events_type` ON `observability_events` (`event_type`,`ts`);
