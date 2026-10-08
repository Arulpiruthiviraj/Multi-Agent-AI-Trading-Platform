-- Quant-First Decision Architecture (2026-10-07): persist decision-policy provenance on
-- consensus_decisions so every ChiefTrader decision can be reconstructed as quant-policy vs
-- consensus-path. All columns nullable: historical rows keep NULL (readers treat NULL as the
-- pre-change consensus path). Additive only, never rewrites history.
ALTER TABLE consensus_decisions ADD COLUMN decision_policy TEXT;
--> statement-breakpoint
ALTER TABLE consensus_decisions ADD COLUMN idea_origin TEXT;
--> statement-breakpoint
ALTER TABLE consensus_decisions ADD COLUMN strategy_id TEXT;
--> statement-breakpoint
ALTER TABLE consensus_decisions ADD COLUMN strategy_lifecycle TEXT;
--> statement-breakpoint
ALTER TABLE consensus_decisions ADD COLUMN authorization_reason TEXT;
