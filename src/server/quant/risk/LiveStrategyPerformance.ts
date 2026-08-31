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
 *
 * Real defect found and fixed (Phase 10, 2026-08-31 Agent Edge Discovery mission): this query had
 * NO exclusion of REPLAY/BACKTEST/SIMULATION-tagged trades, unlike ReflectionEngine.ts's and
 * PortfolioMonitor.ts's own use of the exact same `trades` table for the exact same "is this real
 * organic experience" question - both of those already exclude NON_LIVE_OPENING_TRADE_ENVS
 * (omsEntryPrice.ts). Live query confirmed this is not theoretical: 62 REPLAY-tagged FILLED
 * MOMENTUM_BREAKOUT round-trips and 8 REPLAY-tagged FILLED TREND_FOLLOWING round-trips exist in
 * `trades` right now, both well above MIN_SAMPLE_SIZE_FOR_KELLY - meaning this function could have
 * silently reported a "real, live-history" win rate for those two strategies that was actually
 * entirely simulated/historical-replay evidence, letting QuantSignalAgent's EV/Kelly gate treat
 * REPLAY performance as if it were organic paper experience. Excluding the same environments the
 * other two modules already exclude closes this - a strategy's live win rate now genuinely requires
 * organic (or legacy-untagged) closed trades only.
 * ==========================================================
 */
import { db } from '../../db';
import * as schema from '../../db/schema';
import { and, eq, isNotNull, lte, desc } from 'drizzle-orm';
import { NON_LIVE_OPENING_TRADE_ENVS } from '../../services/omsEntryPrice';

/** A null/blank execution_environment is a legacy pre-tagging row (real trade, no stamp yet), not
 *  REPLAY/BACKTEST - it must stay included; only the known-synthetic environments are excluded.
 *  Same convention as ReflectionEngine.ts/PortfolioMonitor.ts's own use of this exact exclusion set -
 *  filtered in JS (not a SQL NOT IN) so a NULL column value is never accidentally excluded by
 *  SQL's three-valued NOT IN semantics. */
function isOrganicOrUntagged(executionEnvironment: string | null): boolean {
  return !NON_LIVE_OPENING_TRADE_ENVS.has(String(executionEnvironment || '').toUpperCase());
}

export interface LiveStrategyWinRate {
  strategyId: string;
  sampleSize: number;
  wins: number;
  losses: number;
  winProbability: number;
}

/** One real, organic (or legacy-untagged) closed round-trip: a FILLED SELL matched to the most
 *  recent FILLED BUY for the same symbol preceding it (the same heuristic PortfolioMonitor.ts's
 *  live exits already use - this codebase has no per-lot position tracking). Real fill prices,
 *  real quantity, real dollar profitLoss - never a fabricated or estimated number. */
export interface RealClosedRoundTrip {
  strategyId: string;
  symbol: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  profitLoss: number;
  filledAt: string;
}

/**
 * Phase 13 (2026-08-31 real-edge audit): shared by computeLiveStrategyWinRate() (below) and
 * StrategyProfitabilityReport.ts, so this exact real BUY/SELL matching logic exists in exactly
 * one place rather than being reimplemented per consumer. Returns every strategy's real closed
 * round-trips - callers filter by strategyId themselves.
 */
export async function getRealClosedRoundTrips(): Promise<RealClosedRoundTrip[]> {
  const closedSells = (await db.select().from(schema.trades).where(
    and(eq(schema.trades.side, 'SELL'), eq(schema.trades.status, 'FILLED'), isNotNull(schema.trades.profitLoss))
  )).filter((s) => isOrganicOrUntagged(s.executionEnvironment));

  const roundTrips: RealClosedRoundTrip[] = [];
  for (const sell of closedSells) {
    const cutoff = sell.filledAt ?? sell.timestamp;
    const openingBuyCandidates = await db.select().from(schema.trades).where(
      and(
        eq(schema.trades.symbol, sell.symbol),
        eq(schema.trades.side, 'BUY'),
        eq(schema.trades.status, 'FILLED'),
        isNotNull(schema.trades.quantStrategyId),
        lte(schema.trades.filledAt, cutoff),
      )
    ).orderBy(desc(schema.trades.filledAt));
    const openingBuy = openingBuyCandidates.find((b) => isOrganicOrUntagged(b.executionEnvironment));
    if (!openingBuy || !openingBuy.quantStrategyId) continue;
    roundTrips.push({
      strategyId: openingBuy.quantStrategyId,
      symbol: sell.symbol,
      entryPrice: openingBuy.price,
      exitPrice: sell.price,
      quantity: sell.quantity,
      profitLoss: sell.profitLoss ?? 0,
      filledAt: sell.filledAt ?? sell.timestamp,
    });
  }
  return roundTrips;
}

export async function computeLiveStrategyWinRate(strategyId: string): Promise<LiveStrategyWinRate | null> {
  const mine = (await getRealClosedRoundTrips()).filter((r) => r.strategyId === strategyId);
  const wins = mine.filter((r) => r.profitLoss > 0).length;
  const losses = mine.length - wins;
  const sampleSize = wins + losses;
  if (sampleSize === 0) return null;
  return { strategyId, sampleSize, wins, losses, winProbability: wins / sampleSize };
}
