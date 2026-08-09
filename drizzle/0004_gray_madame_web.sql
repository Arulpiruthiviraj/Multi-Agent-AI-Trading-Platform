ALTER TABLE `broker_connections` ADD `account_id` text;
--> statement-breakpoint
ALTER TABLE `broker_connections` ADD `currency` text DEFAULT 'USD';
--> statement-breakpoint
ALTER TABLE `portfolio` ADD `currency` text DEFAULT 'USD';
