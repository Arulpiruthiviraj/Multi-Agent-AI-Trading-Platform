ALTER TABLE news_predictions ADD COLUMN staging_status TEXT DEFAULT 'ACTIVE';
--> statement-breakpoint
ALTER TABLE news_predictions ADD COLUMN expires_at TEXT;
