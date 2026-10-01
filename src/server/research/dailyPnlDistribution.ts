/**
 * ARGUS MASTER IMPLEMENTATION PROGRAM, Workstream D2 (2026-10-01) - $2,000 Active Intraday PAPER
 * Program's required read-only daily P&L distribution report. Extends dailyAttributionReport.ts
 * (reused, not forked) by collapsing its per-(day, strategy) rows into one net-P&L-per-session
 * number, then computing distribution statistics over real sessions only.
 *
 * Session universe: distinct `tradingDate` values from `session_lifecycle_snapshots` (the real,
 * already-populated record of every NY trading day this engine actually ran a cycle on) - this is
 * what makes `zeroTradeSessionPct` honest rather than silently undercounting "sessions" as "days
 * that happened to have a closed trade."
 *
 * Cost honesty: trades.profitLoss is pure gross P&L, `(fillPrice - preTradeEntryPrice) * quantity`
 * (OrderManagement.ts) - no commission/fee is netted out anywhere on this column. costPerTrade and
 * netExpectancyPerTrade are therefore `null` (NO_DATA), never a fabricated $0, until a real
 * per-trade cost source exists (executionQuality.ts's slippage work is the nearest candidate, but
 * it is itself NO_DATA while organic closed PAPER P&L remains 0 - see CLAUDE.md ground truth).
 */
import { sqliteDb } from '../db';
import { buildDailyAttributionReport, type DailyAttributionRow } from './dailyAttributionReport';

export interface DailySessionPnl {
  tradingDate: string;
  netPnl: number;
  tradesCount: number;
  winsCount: number;
  lossesCount: number;
}

export interface DailyPnlDistributionReport {
  sessionsWithKnownActivity: number; // sessions the engine actually ran on (from session_lifecycle_snapshots)
  sessionsWithTrades: number; // subset of the above that had at least one closed FILLED SELL
  zeroTradeSessions: number;
  zeroTradeSessionPct: number | null; // null when sessionsWithKnownActivity is 0 (no data to divide by)

  meanNetPnlPerDay: number | null;
  medianNetPnlPerDay: number | null;
  p10NetPnlPerDay: number | null;
  p25NetPnlPerDay: number | null;
  p75NetPnlPerDay: number | null;
  p90NetPnlPerDay: number | null;
  bestDay: DailySessionPnl | null;
  worstDay: DailySessionPnl | null;

  profitableSessionPct: number | null; // % of sessionsWithTrades that were net positive
  losingSessionPct: number | null;
  sessionsAtOrAboveTwentyDollarsPct: number | null; // % of sessionsWithTrades with netPnl >= $20

  tradesPerSession: number | null; // mean, over sessionsWithTrades

  grossExpectancyPerTrade: number | null; // mean trades.profitLoss across all closed trades in window
  costPerTrade: number | null; // NO_DATA (null) - see module header
  netExpectancyPerTrade: number | null; // NO_DATA (null) - depends on costPerTrade

  maxDrawdownAcrossSessions: number | null; // largest peak-to-trough cumulative net P&L decline across the session sequence
  longestLosingStreakSessions: number; // consecutive sessions (within sessionsWithTrades, in date order) with netPnl < 0

  dataNote: string;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Collapses dailyAttributionReport.ts's per-(day, strategy) rows into one net P&L per day. */
function collapseToSessionPnl(rows: DailyAttributionRow[]): DailySessionPnl[] {
  const byDay = new Map<string, DailySessionPnl>();
  for (const r of rows) {
    const existing = byDay.get(r.tradingDate) ?? {
      tradingDate: r.tradingDate, netPnl: 0, tradesCount: 0, winsCount: 0, lossesCount: 0,
    };
    existing.netPnl += r.realizedPnl;
    existing.tradesCount += r.tradesCount;
    existing.winsCount += r.winsCount;
    existing.lossesCount += r.lossesCount;
    byDay.set(r.tradingDate, existing);
  }
  return Array.from(byDay.values()).sort((a, b) => a.tradingDate.localeCompare(b.tradingDate));
}

function maxDrawdown(sessionsInDateOrder: DailySessionPnl[]): number | null {
  if (sessionsInDateOrder.length === 0) return null;
  let cumulative = 0;
  let peak = 0;
  let worstDrawdown = 0;
  for (const s of sessionsInDateOrder) {
    cumulative += s.netPnl;
    peak = Math.max(peak, cumulative);
    worstDrawdown = Math.min(worstDrawdown, cumulative - peak);
  }
  return worstDrawdown; // <= 0; 0 means no drawdown was ever observed
}

function longestLosingStreak(sessionsInDateOrder: DailySessionPnl[]): number {
  let longest = 0;
  let current = 0;
  for (const s of sessionsInDateOrder) {
    if (s.netPnl < 0) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

export async function computeDailyPnlDistribution(sinceDate?: string): Promise<DailyPnlDistributionReport> {
  const attributionRows = await buildDailyAttributionReport(sinceDate);
  const sessions = collapseToSessionPnl(attributionRows);

  const sessionDateQuery = sinceDate
    ? sqliteDb.prepare('SELECT DISTINCT trading_date FROM session_lifecycle_snapshots WHERE trading_date >= ?').all(sinceDate)
    : sqliteDb.prepare('SELECT DISTINCT trading_date FROM session_lifecycle_snapshots').all();
  const knownSessionDates = new Set((sessionDateQuery as Array<{ trading_date: string }>).map((r) => r.trading_date));
  // A session with trades but somehow missing from session_lifecycle_snapshots (e.g. older data
  // predating that table) still counts as known activity - the trade itself is proof the engine ran.
  for (const s of sessions) knownSessionDates.add(s.tradingDate);

  const sessionsWithKnownActivity = knownSessionDates.size;
  const sessionsWithTrades = sessions.length;
  const zeroTradeSessions = sessionsWithKnownActivity - sessionsWithTrades;

  const netPnls = sessions.map((s) => s.netPnl);
  const sortedPnls = [...netPnls].sort((a, b) => a - b);
  const profitableCount = sessions.filter((s) => s.netPnl > 0).length;
  const losingCount = sessions.filter((s) => s.netPnl < 0).length;
  const atOrAboveTwentyCount = sessions.filter((s) => s.netPnl >= 20).length;

  const bestDay = sessions.length > 0 ? sessions.reduce((a, b) => (b.netPnl > a.netPnl ? b : a)) : null;
  const worstDay = sessions.length > 0 ? sessions.reduce((a, b) => (b.netPnl < a.netPnl ? b : a)) : null;

  const totalTrades = sessions.reduce((sum, s) => sum + s.tradesCount, 0);
  const totalPnl = sessions.reduce((sum, s) => sum + s.netPnl, 0);
  const grossExpectancyPerTrade = totalTrades > 0 ? totalPnl / totalTrades : null;

  return {
    sessionsWithKnownActivity,
    sessionsWithTrades,
    zeroTradeSessions,
    zeroTradeSessionPct: sessionsWithKnownActivity > 0 ? (zeroTradeSessions / sessionsWithKnownActivity) * 100 : null,

    meanNetPnlPerDay: mean(netPnls),
    medianNetPnlPerDay: sortedPnls.length > 0 ? percentile(sortedPnls, 0.5) : null,
    p10NetPnlPerDay: sortedPnls.length > 0 ? percentile(sortedPnls, 0.10) : null,
    p25NetPnlPerDay: sortedPnls.length > 0 ? percentile(sortedPnls, 0.25) : null,
    p75NetPnlPerDay: sortedPnls.length > 0 ? percentile(sortedPnls, 0.75) : null,
    p90NetPnlPerDay: sortedPnls.length > 0 ? percentile(sortedPnls, 0.90) : null,
    bestDay,
    worstDay,

    profitableSessionPct: sessionsWithTrades > 0 ? (profitableCount / sessionsWithTrades) * 100 : null,
    losingSessionPct: sessionsWithTrades > 0 ? (losingCount / sessionsWithTrades) * 100 : null,
    sessionsAtOrAboveTwentyDollarsPct: sessionsWithTrades > 0 ? (atOrAboveTwentyCount / sessionsWithTrades) * 100 : null,

    tradesPerSession: sessionsWithTrades > 0 ? totalTrades / sessionsWithTrades : null,

    grossExpectancyPerTrade,
    costPerTrade: null,
    netExpectancyPerTrade: null,

    maxDrawdownAcrossSessions: maxDrawdown(sessions),
    longestLosingStreakSessions: longestLosingStreak(sessions),

    dataNote: totalTrades === 0
      ? 'NO_DATA: zero closed organic PAPER FILLED SELL trades in the queried window - every statistic above is null/zero by honest absence of data, not a computed result.'
      : 'costPerTrade/netExpectancyPerTrade are NO_DATA (null): trades.profitLoss is gross only, no per-trade commission/fee is tracked on that column yet.',
  };
}
