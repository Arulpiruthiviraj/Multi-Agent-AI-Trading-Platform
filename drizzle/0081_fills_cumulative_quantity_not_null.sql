PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_fills` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` text NOT NULL,
	`broker_fill_id` text,
	`quantity` real NOT NULL,
	`price` real NOT NULL,
	`filled_at` text NOT NULL,
	`cumulative_quantity` real NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_fills`("id", "order_id", "broker_fill_id", "quantity", "price", "filled_at", "cumulative_quantity") SELECT "id", "order_id", "broker_fill_id", "quantity", "price", "filled_at", "cumulative_quantity" FROM `fills`;--> statement-breakpoint
DROP TABLE `fills`;--> statement-breakpoint
ALTER TABLE `__new_fills` RENAME TO `fills`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_fills_order_cumulative` ON `fills` (`order_id`,`cumulative_quantity`);
