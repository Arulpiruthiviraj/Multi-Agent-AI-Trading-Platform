import { describe, it, expect } from 'vitest';
import {
  consecutiveLossBlocksNewBuys,
  dailyLossBlocksNewBuys,
  drawdownBlocksNewBuys,
  orderRateBlocksNewBuys,
} from './BacktestRiskParity';
import { tradingSafety } from '../../config/tradingSafety';

describe('BacktestRiskParity — same inequalities as live RiskEngine', () => {
  it('daily_loss trips at kill-switch fraction of the configured limit', () => {
    const limit = 1000;
    const start = 10000;
    const justUnder = start - limit * tradingSafety.dailyLossKillSwitchFraction + 1;
    const atOrOver = start - limit * tradingSafety.dailyLossKillSwitchFraction;
    expect(dailyLossBlocksNewBuys({ equityNow: justUnder, dayStartEquity: start, dailyLossLimitDollars: limit })).toBe(false);
    expect(dailyLossBlocksNewBuys({ equityNow: atOrOver, dayStartEquity: start, dailyLossLimitDollars: limit })).toBe(true);
  });

  it('consecutive_loss uses tradingSafety.maxConsecutiveLosses, not a test-local 3', () => {
    const n = tradingSafety.maxConsecutiveLosses;
    const almost = Array(n - 1).fill(-1);
    const full = Array(n).fill(-1);
    expect(consecutiveLossBlocksNewBuys(almost)).toBe(false);
    expect(consecutiveLossBlocksNewBuys(full)).toBe(true);
    expect(consecutiveLossBlocksNewBuys([...full.slice(0, n - 1), 1])).toBe(false);
  });

  it('portfolio_drawdown trips at the configured pct from peak', () => {
    expect(drawdownBlocksNewBuys({ equityNow: 86, peakEquity: 100, maxPortfolioDrawdownPct: 0.15 })).toBe(false);
    expect(drawdownBlocksNewBuys({ equityNow: 85, peakEquity: 100, maxPortfolioDrawdownPct: 0.15 })).toBe(true);
  });

  it('order_rate_limit counts buys in a 60s window', () => {
    const now = 1_000_000;
    const max = 5;
    const stamps = [now - 1000, now - 2000, now - 3000, now - 4000];
    expect(orderRateBlocksNewBuys({ buyTimestampsMs: stamps, nowMs: now, maxOrdersPerMinute: max })).toBe(false);
    expect(orderRateBlocksNewBuys({ buyTimestampsMs: [...stamps, now - 500, now - 600], nowMs: now, maxOrdersPerMinute: max })).toBe(true);
    expect(orderRateBlocksNewBuys({ buyTimestampsMs: Array(10).fill(now - 61_000), nowMs: now, maxOrdersPerMinute: max })).toBe(false);
  });
});
