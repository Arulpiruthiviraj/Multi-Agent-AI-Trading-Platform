/**
 * ARGUS MASTER TRANSFORMATION MANDATE Part 21 - Daily Performance Attribution. Real, read-only
 * composition over `trades` - never a second P&L ledger. Answers "what made money, what lost
 * money, why" using only real, already-realized P&L: FILLED SELL trades with a non-null
 * `profit_loss` (set by OrderManagement.ts at the real moment of sale, `(fillPrice -
 * preTradeEntryPrice) * quantity`), grouped by real NY trading date (`getTradingDateStr`,
 * TradingCalendar.ts, the same calendar-day boundary gate 8's daily-loss kill-switch uses) and
 * real strategy id (`trades.quant_strategy_id`, set at order-insert time from ChiefTraderAgent's
 * own `supportingQuantDetail` - null/"UNATTRIBUTED" for non-QuantEngine-sourced trades, never
 * fabricated).
 *
 * Deliberately does NOT reuse `daily_strategy_performance` (CampaignTracker.ts's own table) as the
 * primary source - that table is written only when the optional Daily Goal Campaign feature
 * (`settings.campaign_enabled`, default off) is active, so it would silently under-report real
 * attribution in any deployment that has never turned the campaign on. Querying `trades` directly
 * is the general-purpose, always-available source.
 *
 * `executionEnvironment = 'PAPER'` only - REPLAY/BACKTEST/SIMULATION/LIVE/UNKNOWN rows are
 * excluded, never blended into the same P&L number (CLAUDE.md's own repeated rule). As of this
 * writing organic closed PAPER FILLED SELL P&L is 0 (CLAUDE.md ground truth) - this report will
 * honestly return an empty array until that changes, never a fabricated row.
 */
import { db } from '../db';
import { trades } from '../db/schema';
import { and, eq, isNotNull } from 'drizzle-orm';
import { getTradingDateStr } from '../core/TradingCalendar';

export interface DailyAttributionRow {
  tradingDate: string; // America/New_York YYYY-MM-DD
  strategyId: string; // real trades.quant_strategy_id, or 'UNATTRIBUTED' when null (never fabricated)
  realizedPnl: number;
  tradesCount: number;
  winsCount: number;
  lossesCount: number;
}

export interface DailyAttributionSummary {
  totalRealizedPnl: number;
  totalTradesCount: number;
  totalWinsCount: number;
  totalLossesCount: number;
  bestStrategyId: string | null; // highest realizedPnl across the window, null when no rows
  worstStrategyId: string | null; // lowest realizedPnl across the window, null when no rows
}

export async function buildDailyAttributionReport(sinceDate?: string): Promise<DailyAttributionRow[]> {
  const rows = await db.select().from(trades)
    .where(and(
      eq(trades.status, 'FILLED'),
      eq(trades.side, 'SELL'),
      eq(trades.executionEnvironment, 'PAPER'),
      isNotNull(trades.profitLoss),
    ))
    .all();

  const grouped = new Map<string, DailyAttributionRow>();
  for (const t of rows) {
    const tradingDate = getTradingDateStr(new Date(t.filledAt ?? t.timestamp));
    if (sinceDate && tradingDate < sinceDate) continue;
    const strategyId = t.quantStrategyId ?? 'UNATTRIBUTED';
    const key = `${tradingDate}|${strategyId}`;
    const pnl = t.profitLoss as number;

    const existing = grouped.get(key) ?? {
      tradingDate, strategyId, realizedPnl: 0, tradesCount: 0, winsCount: 0, lossesCount: 0,
    };
    existing.realizedPnl += pnl;
    existing.tradesCount += 1;
    if (pnl > 0) existing.winsCount += 1;
    else if (pnl < 0) existing.lossesCount += 1;
    grouped.set(key, existing);
  }

  return Array.from(grouped.values()).sort((a, b) => {
    if (a.tradingDate !== b.tradingDate) return b.tradingDate.localeCompare(a.tradingDate);
    return b.realizedPnl - a.realizedPnl;
  });
}

export function summarizeDailyAttribution(rows: DailyAttributionRow[]): DailyAttributionSummary {
  if (rows.length === 0) {
    return { totalRealizedPnl: 0, totalTradesCount: 0, totalWinsCount: 0, totalLossesCount: 0, bestStrategyId: null, worstStrategyId: null };
  }
  // Aggregate per-strategy across the whole window (not per-day) to find best/worst contributor.
  const byStrategy = new Map<string, number>();
  let totalRealizedPnl = 0, totalTradesCount = 0, totalWinsCount = 0, totalLossesCount = 0;
  for (const r of rows) {
    byStrategy.set(r.strategyId, (byStrategy.get(r.strategyId) ?? 0) + r.realizedPnl);
    totalRealizedPnl += r.realizedPnl;
    totalTradesCount += r.tradesCount;
    totalWinsCount += r.winsCount;
    totalLossesCount += r.lossesCount;
  }
  let bestStrategyId: string | null = null, worstStrategyId: string | null = null;
  let bestPnl = -Infinity, worstPnl = Infinity;
  for (const [strategyId, pnl] of byStrategy) {
    if (pnl > bestPnl) { bestPnl = pnl; bestStrategyId = strategyId; }
    if (pnl < worstPnl) { worstPnl = pnl; worstStrategyId = strategyId; }
  }
  return { totalRealizedPnl, totalTradesCount, totalWinsCount, totalLossesCount, bestStrategyId, worstStrategyId };
}

export function formatDailyAttributionReport(rows: DailyAttributionRow[], summary: DailyAttributionSummary): string {
  const lines = [
    'DAILY PERFORMANCE ATTRIBUTION (real organic PAPER FILLED SELL P&L only)',
    '-------------------------------------------------------------------------',
  ];
  if (rows.length === 0) {
    lines.push('NO_DATA - no organic PAPER FILLED SELL trade with realized P&L exists yet.');
    return lines.join('\n');
  }
  lines.push(
    `totalRealizedPnl=${summary.totalRealizedPnl.toFixed(2)}  trades=${summary.totalTradesCount}  wins=${summary.totalWinsCount}  losses=${summary.totalLossesCount}`,
    `bestStrategy=${summary.bestStrategyId ?? 'N/A'}  worstStrategy=${summary.worstStrategyId ?? 'N/A'}`,
    '',
    'Date'.padEnd(12) + 'Strategy'.padEnd(24) + 'RealizedPnL'.padEnd(14) + 'Trades'.padEnd(8) + 'W/L',
  );
  for (const r of rows) {
    lines.push(
      r.tradingDate.padEnd(12)
      + r.strategyId.padEnd(24)
      + r.realizedPnl.toFixed(2).padEnd(14)
      + String(r.tradesCount).padEnd(8)
      + `${r.winsCount}/${r.lossesCount}`,
    );
  }
  return lines.join('\n');
}
