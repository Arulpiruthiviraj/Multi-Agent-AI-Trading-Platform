import { db } from '../db';
import { tradePlanRevalidations } from '../db/schema';
import { lt } from 'drizzle-orm';

/**
 * 2026-10-07 Discovery-D2: retention bound for the trade_plan_revalidations ledger, in days.
 * A code constant (not a config entry): this is a storage-hygiene bound, not a trading
 * parameter, and no operator tuning story exists for it yet. 30 days comfortably covers every
 * forensic lookback the revalidation history actually serves (intraday revalidation
 * forensics, RTH handoff review) while bounding the write-amplified ledger.
 *
 * 2026-10-09 defect hunt (import-cycle TDZ): this constant and pruneTradePlanRevalidations()
 * MUST live in this leaf module, not in TradePlanBuilder.ts. The operational-retention sweep
 * reaches them via a lazy dynamic import that can resolve while TradePlanBuilder itself is
 * still mid-evaluation (import cycle through the continuous module graph); a const declared
 * in TradePlanBuilder threw "Cannot access before initialization" (TDZ) on that path,
 * surfacing as an unhandled rejection that broke the sweep. This module imports only
 * db/schema/drizzle - it cannot participate in that cycle, so the const is always
 * initialized before any caller can reach it. Do not move these back into TradePlanBuilder.
 */
export const TRADE_PLAN_REVALIDATION_RETENTION_DAYS = 30;

/**
 * 2026-10-07 Discovery-D2: retention prune for the trade_plan_revalidations ledger. Deletes rows
 * older than TRADE_PLAN_REVALIDATION_RETENTION_DAYS. Code-based, no migration - the table is
 * append-only history with no long-term audit-trail requirement beyond the retention window
 * (unlike trades/fills/risk_assessments, which are never pruned). Called from the operational
 * retention sweep (src/server/db/operationalRetention.ts), never from any trading decision path.
 * Returns the number of rows deleted.
 */
export async function pruneTradePlanRevalidations(nowMs: number = Date.now()): Promise<number> {
  const cutoffIso = new Date(nowMs - TRADE_PLAN_REVALIDATION_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    const result = await db.delete(tradePlanRevalidations).where(lt(tradePlanRevalidations.revalidatedAt, cutoffIso));
    return (result as unknown as { changes?: number }).changes ?? 0;
  } catch (e) {
    console.error('[TradePlanBuilder] Failed to prune revalidation history', e);
    return 0;
  }
}
