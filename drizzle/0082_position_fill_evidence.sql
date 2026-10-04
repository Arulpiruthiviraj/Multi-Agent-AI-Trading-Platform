ALTER TABLE trades ADD COLUMN position_quantity_before real;
--> statement-breakpoint
ALTER TABLE trades ADD COLUMN position_average_price_before real;
--> statement-breakpoint
ALTER TABLE fills ADD COLUMN position_quantity_after real;
--> statement-breakpoint
ALTER TABLE fills ADD COLUMN position_average_price_after real;
--> statement-breakpoint
ALTER TABLE fills ADD COLUMN realized_pnl real;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_trades_position_scope ON trades(broker_id, execution_environment, symbol);
