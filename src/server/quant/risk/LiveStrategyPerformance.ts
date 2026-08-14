/**
 * ==========================================================
 * Module: quant/risk/LiveStrategyPerformance
 *
 * Purpose:
 * Phase 16F (ARGUS_PHASE16_READINESS_REPORT.md) - a real, live-history win-rate estimate per
 * QuantEngine strategy, so QuantSignalAgent can require a genuine positive expected value
 * (ExpectedValue.ts, already real, previously backtest-only) before emitting a live trade idea -
 * closing the finding that live QuantEngine approval depended only on ChiefTrader's confidence
 * threshold, never on any quantitative EV/risk-reward check.
 *
 * Real trade-matching, not a fabricated estimate: `trades.quantStrategyId` (Phase 16B) identifies
 * which strategy opened a BUY. This codebase has no per-lot position tracking (`portfolio` is a
 * single blended-average-price row per symbol, same simplification every other module here already
 * makes), so a closing SELL is matched to the most recent FILLED BUY for the same symbol that
 * precedes it - the same heuristic PortfolioMonitor.ts (Phase 16B) already uses for live exits.
 * Returns null (never a fabricated rate) when zero real closed trades exist for a strategy - which,
 * per ARGUS_PAPER_TRADING_VALIDATION.md's own finding, is the real state of this environment today.
 * ==========================================================
 */
import { db } from '../../db';
import * as schema from '../../db/schema';
import { and, eq, isNotNull, lte, desc } from 'drizzle-orm';

export interface LiveStrategyWinRate {
  strategyId: string;
  sampleSize: number;
  wins: number;
  losses: number;
  winProbability: number;
}

export async function computeLiveStrategyWinRate(strategyId: string): Promise<LiveStrategyWinRate | null> {
  const closedSells = await db.select().from(schema.trades).where(
    and(eq(schema.trades.side, 'SELL'), eq(schema.trades.status, 'FILLED'), isNotNull(schema.trades.profitLoss))
  );

  let wins = 0;
  let losses = 0;

  for (const sell of closedSells) {
    const cutoff = sell.filledAt ?? sell.timestamp;
    const [openingBuy] = await db.select().from(schema.trades).where(
      and(
        eq(schema.trades.symbol, sell.symbol),
        eq(schema.trades.side, 'BUY'),
        eq(schema.trades.status, 'FILLED'),
        isNotNull(schema.trades.quantStrategyId),
        lte(schema.trades.filledAt, cutoff),
      )
    ).orderBy(desc(schema.trades.filledAt)).limit(1);

    if (!openingBuy || openingBuy.quantStrategyId !== strategyId) continue;
    if ((sell.profitLoss ?? 0) > 0) wins++; else losses++;
  }

  const sampleSize = wins + losses;
  if (sampleSize === 0) return null;
  return { strategyId, sampleSize, wins, losses, winProbability: wins / sampleSize };
}
