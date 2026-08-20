/**
 * Resolve cost basis for a SELL so OMS can persist trades.profit_loss.
 * Broker positions first; on throw / missing symbol, local portfolio then opening BUY trade.
 */
import { db } from '../db';
import { portfolio, trades } from '../db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { replaySafety } from '../replay/replaySafety';

const NON_LIVE_OPENING_TRADE_ENVS = new Set([
  'REPLAY',
  'BACKTEST',
  'SIMULATION',
  'HISTORICAL_REPLAY',
  'HISTORICAL_SIMULATION',
  'TELEMETRY_PULSE',
]);

function positivePrice(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Local portfolio.averagePrice for symbol, if present and positive. */
export async function lookupLocalPortfolioEntryPrice(symbol: string): Promise<number | null> {
  try {
    const rows = await db.select().from(portfolio).where(eq(portfolio.symbol, symbol)).limit(1);
    const avg = rows[0]?.averagePrice;
    return positivePrice(avg);
  } catch (e) {
    console.warn(`[OMS] Local portfolio entry lookup failed for ${symbol}`, e);
    return null;
  }
}

/**
 * Most recent live FILLED BUY price for symbol (cost basis). Excludes REPLAY/BACKTEST/etc.
 * Same exclusion policy as PortfolioMonitor.resolveOpeningTradeForLiveExit.
 */
export async function lookupOpeningTradeCostBasis(symbol: string): Promise<number | null> {
  try {
    const candidates = await db.select().from(trades)
      .where(and(eq(trades.symbol, symbol), eq(trades.side, 'BUY'), eq(trades.status, 'FILLED')))
      .orderBy(desc(trades.filledAt))
      .limit(40);
    const opening = candidates.find((t) => {
      const env = String(t.executionEnvironment || '').toUpperCase();
      if (NON_LIVE_OPENING_TRADE_ENVS.has(env)) return false;
      if (t.traceId && String(t.traceId).startsWith(replaySafety.replayTracePrefix)) return false;
      return true;
    });
    return positivePrice(opening?.price);
  } catch (e) {
    console.warn(`[OMS] Opening-trade cost-basis lookup failed for ${symbol}`, e);
    return null;
  }
}

export type BrokerPositionLike = { symbol: string; entryPrice?: number | null };

/**
 * Prefer broker position entryPrice; on failure or missing symbol fall back to local
 * portfolio averagePrice, then opening FILLED BUY trade price.
 */
export async function resolvePreTradeEntryPrice(
  symbol: string,
  fetchPositions: () => Promise<BrokerPositionLike[]>,
): Promise<number | null> {
  try {
    const positions = await fetchPositions();
    const match = Array.isArray(positions)
      ? positions.find((p) => p.symbol === symbol)
      : undefined;
    const fromBroker = positivePrice(match?.entryPrice);
    if (fromBroker !== null) return fromBroker;
  } catch (e) {
    console.warn(
      `[OMS] Broker positions() failed for pre-trade entry of ${symbol} — falling back to local portfolio / trades`,
      e,
    );
  }

  const fromLocal = await lookupLocalPortfolioEntryPrice(symbol);
  if (fromLocal !== null) return fromLocal;

  return lookupOpeningTradeCostBasis(symbol);
}
