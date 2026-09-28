CREATE TABLE `crypto_paper_broker_state` (
	`id` text PRIMARY KEY NOT NULL,
	`cash` real NOT NULL,
	`initial_cash` real NOT NULL,
	`realized_pnl` real DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `crypto_paper_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`client_order_id` text,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`quantity` real NOT NULL,
	`filled_quantity` real DEFAULT 0 NOT NULL,
	`price` real,
	`stop_price` real,
	`average_fill_price` real,
	`rejection_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_crypto_paper_orders_client_order_id` ON `crypto_paper_orders` (`client_order_id`);--> statement-breakpoint
CREATE INDEX `idx_crypto_paper_orders_symbol_status` ON `crypto_paper_orders` (`symbol`,`status`);--> statement-breakpoint
CREATE TABLE `crypto_paper_positions` (
	`symbol` text PRIMARY KEY NOT NULL,
	`quantity` real NOT NULL,
	`entry_price` real NOT NULL,
	`entry_fees` real DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
