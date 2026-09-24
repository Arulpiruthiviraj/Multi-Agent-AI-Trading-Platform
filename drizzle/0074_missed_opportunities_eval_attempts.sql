ALTER TABLE `missed_opportunities` ADD `evaluation_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `missed_opportunities` ADD `last_evaluation_attempt_at` text;
