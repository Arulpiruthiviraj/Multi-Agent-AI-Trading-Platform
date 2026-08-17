CREATE TABLE IF NOT EXISTS `reconciliation_acknowledgements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`broker` text NOT NULL,
	`broker_order_id` text NOT NULL,
	`symbol` text NOT NULL,
	`side` text,
	`quantity` real,
	`average_fill_price` real,
	`status` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`fingerprint` text NOT NULL,
	`broker_snapshot_json` text,
	`acknowledged_at` text NOT NULL,
	`revoked_at` text,
	`revoked_by` text,
	`revoke_reason` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_recon_ack_broker_order`
	ON `reconciliation_acknowledgements` (`broker`, `broker_order_id`);
