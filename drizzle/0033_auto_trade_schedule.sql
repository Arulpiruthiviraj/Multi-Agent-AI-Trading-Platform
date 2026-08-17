ALTER TABLE `settings` ADD `auto_trade_schedule_enabled` integer DEFAULT false;
--> statement-breakpoint
ALTER TABLE `settings` ADD `auto_trade_schedule_start_time` text DEFAULT '09:30';
--> statement-breakpoint
ALTER TABLE `settings` ADD `auto_trade_schedule_end_time` text DEFAULT '16:00';
--> statement-breakpoint
ALTER TABLE `settings` ADD `auto_trade_schedule_timezone` text DEFAULT 'America/New_York';
