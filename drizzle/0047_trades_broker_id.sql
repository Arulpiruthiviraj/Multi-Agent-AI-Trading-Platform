-- Broker-scoped trade ledger: partition history by active order-placing adapter.
-- Legacy rows default to alpaca (historical Argus paper path before dual-IBKR).
ALTER TABLE `trades` ADD `broker_id` text;
--> statement-breakpoint
UPDATE `trades` SET `broker_id` = 'alpaca' WHERE `broker_id` IS NULL;
