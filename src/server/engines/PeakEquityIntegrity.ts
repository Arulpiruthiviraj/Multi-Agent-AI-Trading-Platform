/**
 * ==========================================================
 * Module: PeakEquityIntegrity
 *
 * Peak Equity Recovery (2026-08-26). Pre-market forensic audit found settings.peakEquity stuck at
 * exactly 1,000,000 against a real Alpaca PAPER equity of ~$100,050 — RiskEngine gate #10
 * (portfolio_drawdown) was computing a permanent ~90% "drawdown" and rejecting every BUY and SELL,
 * including a legitimate EOD-flatten risk-exit SELL on an existing GLD position.
 *
 * Root cause (structurally confirmed, exact originating run not recoverable — no
 * settings-change-history table exists to name it): RiskEngine.ts's own header comment on the
 * portfolio_drawdown gate documents a real, already-fixed defect (2026-08-24 pass) where this was
 * the only gate with no replay branch — it unconditionally read AND WROTE the shared live
 * settings.peakEquity row regardless of whether equityNow came from the real broker or an
 * isolated replay/backtest equity curve. That fix stops NEW contamination; it does not repair a
 * value already poisoned by a pre-fix run. Exhaustively checked both real historical-run ledgers
 * (replay_runs, quant_strategy_backtests) in the live database for a matching 1,000,000-equity
 * signature — neither contains one, so the exact originating event predates or falls outside both
 * currently-retained ledgers. That absence is itself reported, not glossed over.
 *
 * This module does NOT blindly overwrite peakEquity, and does NOT reset it merely because current
 * equity is lower than stored (a real, legitimate high-water mark — e.g. 100k -> 120k -> 115k -
 * must stay at 120k). It only re-baselines when BOTH:
 *   1. storedPeak > currentBrokerEquity * tradingSafety.peakEquityMaxPlausibleMultiplier, AND
 *   2. real organic PAPER closed-trade count is too small to plausibly explain that much organic
 *      growth (< researchSafety.minPaperTrades).
 * Both conditions true = CONTAMINATED -> safe-initialize to current real broker equity (a fresh
 * baseline, never a fabricated historical peak) and persist a full audit record. Condition 1 true
 * but condition 2 false (a real account with real trading history) = SUSPICIOUS_BUT_PLAUSIBLE -
 * logged, never auto-repaired. Neither condition true = CLEAN - untouched.
 * ==========================================================
 */
import { db } from '../db';
import * as schema from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { tradingSafety } from '../config/tradingSafety';
import { researchSafety } from '../config/researchSafety';
import { isPositiveFiniteMoney } from './AccountEquity';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';

export type PeakEquityIntegrityOutcome =
  | { status: 'CLEAN'; storedPeak: number | null; currentEquity: number }
  | { status: 'SUSPICIOUS_BUT_PLAUSIBLE'; storedPeak: number; currentEquity: number; organicPaperTradeCount: number }
  | { status: 'CONTAMINATED_AND_REPAIRED'; oldValue: number; newValue: number; organicPaperTradeCount: number }
  | { status: 'SKIPPED_INVALID_EQUITY' };

async function countOrganicPaperFilledTrades(): Promise<number> {
  const rows = await db.select().from(schema.trades).where(
    and(eq(schema.trades.executionEnvironment, 'PAPER'), eq(schema.trades.status, 'FILLED')),
  );
  return rows.length;
}

/**
 * Run once at boot, after BrokerManager is initialized and before trading begins. Idempotent and
 * safe to call every restart — a CLEAN or already-repaired state is a no-op on every subsequent
 * call.
 */
export async function reconcilePeakEquityIntegrity(currentBrokerEquity: number): Promise<PeakEquityIntegrityOutcome> {
  if (!isPositiveFiniteMoney(currentBrokerEquity)) {
    return { status: 'SKIPPED_INVALID_EQUITY' };
  }

  const settingsRows = await db.select().from(schema.settings).limit(1);
  const storedPeak = settingsRows[0]?.peakEquity ?? null;

  if (storedPeak === null || storedPeak <= 0) {
    return { status: 'CLEAN', storedPeak, currentEquity: currentBrokerEquity };
  }

  const plausibleCeiling = currentBrokerEquity * tradingSafety.peakEquityMaxPlausibleMultiplier;
  if (storedPeak <= plausibleCeiling) {
    return { status: 'CLEAN', storedPeak, currentEquity: currentBrokerEquity };
  }

  const organicPaperTradeCount = await countOrganicPaperFilledTrades();
  if (organicPaperTradeCount >= researchSafety.minPaperTrades) {
    // A real account with real trading history could plausibly have grown this much — do not
    // silently overwrite what might be a genuine, hard-earned peak. Report, do not guess.
    observeSafe(() => {
      structuredLogger.warn('peak_equity_integrity_suspicious', {
        category: 'TRADING_SAFETY',
        eventType: 'PEAK_EQUITY_INTEGRITY_SUSPICIOUS',
        storedPeak,
        currentBrokerEquity,
        plausibleCeiling,
        organicPaperTradeCount,
      });
    });
    return { status: 'SUSPICIOUS_BUT_PLAUSIBLE', storedPeak, currentEquity: currentBrokerEquity, organicPaperTradeCount };
  }

  // Both conditions met: implausible multiple AND not enough real trading history to explain it.
  // Safe-initialize to current real broker equity - a fresh baseline, not a fabricated historical
  // peak. Future genuine gains still ratchet this up normally via RiskEngine's existing logic.
  const now = new Date().toISOString();
  await db.update(schema.settings).set({ peakEquity: currentBrokerEquity }).run();
  await db.insert(schema.configChangeEvents).values({
    setting: 'peakEquity',
    oldEffective: String(storedPeak),
    newValue: String(currentBrokerEquity),
    source: 'PeakEquityIntegrity.reconcilePeakEquityIntegrity',
    operator: 'system-auto-repair',
    restartRequired: false,
    createdAt: now,
  });
  observeSafe(() => {
    structuredLogger.error('peak_equity_integrity_repaired', {
      category: 'TRADING_SAFETY',
      eventType: 'PEAK_EQUITY_INTEGRITY_REPAIRED',
      oldValue: storedPeak,
      newValue: currentBrokerEquity,
      plausibleCeiling,
      organicPaperTradeCount,
      reason: `storedPeak (${storedPeak}) exceeded ${tradingSafety.peakEquityMaxPlausibleMultiplier}x real broker equity (${currentBrokerEquity}) with only ${organicPaperTradeCount} organic PAPER closed trades (< ${researchSafety.minPaperTrades}) - not plausibly organic. Re-baselined to current real equity, not a fabricated historical peak.`,
    });
  });
  return { status: 'CONTAMINATED_AND_REPAIRED', oldValue: storedPeak, newValue: currentBrokerEquity, organicPaperTradeCount };
}
