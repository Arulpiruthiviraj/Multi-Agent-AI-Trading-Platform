/**
 * Shared circuit-breaker math used by live RiskEngine and BacktestEngine.
 * Formulas match RiskEngine.evaluateRiskSerialized daily_loss / consecutive_loss /
 * portfolio_drawdown / order_rate_limit. Backtest cannot call RiskEngine (live broker,
 * news, clock). These predicates are the same inequalities against tradingSafety.json.
 */
import { tradingSafety } from '../../config/tradingSafety';

export function dailyLossBlocksNewBuys(input: {
  equityNow: number;
  dayStartEquity: number;
  dailyLossLimitDollars: number;
}): boolean {
  const dailyLoss = Math.max(0, input.dayStartEquity - input.equityNow);
  return dailyLoss >= input.dailyLossLimitDollars * tradingSafety.dailyLossKillSwitchFraction;
}

export function consecutiveLossBlocksNewBuys(recentClosedPnlsNewestFirst: number[]): boolean {
  const n = tradingSafety.maxConsecutiveLosses;
  if (recentClosedPnlsNewestFirst.length < n) return false;
  return recentClosedPnlsNewestFirst.slice(0, n).every(p => p < 0);
}

export function drawdownBlocksNewBuys(input: {
  equityNow: number;
  peakEquity: number;
  maxPortfolioDrawdownPct: number;
}): boolean {
  const drawdownPct = input.peakEquity > 0
    ? Math.max(0, (input.peakEquity - input.equityNow) / input.peakEquity)
    : 0;
  return drawdownPct >= input.maxPortfolioDrawdownPct;
}

/** Live gate counts risk_assessments in the last 60s. Backtest counts BUY fills in the same window of simulated time. */
export function orderRateBlocksNewBuys(input: {
  buyTimestampsMs: number[];
  nowMs: number;
  maxOrdersPerMinute: number;
}): boolean {
  const recent = input.buyTimestampsMs.filter(t => input.nowMs - t < 60_000).length;
  return recent >= input.maxOrdersPerMinute;
}

export function nySessionKey(timestampMs: number): string {
  return new Date(timestampMs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
