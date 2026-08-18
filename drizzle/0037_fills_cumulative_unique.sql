ALTER TABLE `fills` ADD COLUMN `cumulative_quantity` REAL;
--> statement-breakpoint
UPDATE `fills`
SET `cumulative_quantity` = (
  SELECT SUM(f2.`quantity`) FROM `fills` f2
  WHERE f2.`order_id` = `fills`.`order_id` AND f2.`id` <= `fills`.`id`
)
WHERE `cumulative_quantity` IS NULL;
--> statement-breakpoint
DELETE FROM `fills` WHERE `id` NOT IN (
  SELECT MIN(`id`) FROM `fills` GROUP BY `order_id`, `cumulative_quantity`
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_fills_order_cumulative` ON `fills` (`order_id`, `cumulative_quantity`);
