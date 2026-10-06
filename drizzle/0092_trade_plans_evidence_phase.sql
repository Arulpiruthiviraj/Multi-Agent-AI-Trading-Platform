-- Pre-market tradeplan lifecycle (2026-10-06, local-only): record what session phase
-- built the plan and the evidence timestamp it was built from. A plan built at 08:23
-- must never pretend to be a 04:00 plan: evidence_asof + session_phase make that honest.
ALTER TABLE trade_plans ADD COLUMN evidence_asof TEXT;
--> statement-breakpoint
ALTER TABLE trade_plans ADD COLUMN session_phase TEXT;
