import { describe, expect, it } from 'vitest';
import { measureMultiTrade, type MultiTradeBar, type MultiTradeInput } from './multiTradeMetrics';

const bar: MultiTradeBar = {
  minCompletedTrades: 2, minWinners: 1, minLosers: 1, minDistinctEntrySizes: 2,
  requireCapitalOrPositionCapRejection: true, requireCooldownRejection: true, requireCapitalReuse: true, requireNetProfitAfterCosts: false,
};

const base = (): MultiTradeInput => ({
  initialCapital: 20000,
  fills: [
    { orderId: 'b1', symbol: 'A', side: 'BUY', quantity: 10, price: 100, feeUsd: 0.05, atMs: 1 },
    { orderId: 's1', symbol: 'A', side: 'SELL', quantity: 10, price: 105, feeUsd: 0.05, atMs: 2 },   // +50 gross win
    { orderId: 'b2', symbol: 'B', side: 'BUY', quantity: 20, price: 50, feeUsd: 0.1, atMs: 3 },       // after a close: capital reuse, different size
    { orderId: 's2', symbol: 'B', side: 'SELL', quantity: 20, price: 49, feeUsd: 0.1, atMs: 4 },      // -20 gross loss
  ],
  riskAssessments: [
    { side: 'BUY', approved: false, rejectionGate: 'argus_capital_allocation', symbol: 'C', atMs: 1.5 },
    { side: 'BUY', approved: false, rejectionGate: 'post_loss_cooldown', symbol: 'A', atMs: 5 },
  ],
});

describe('multiTradeMetrics', () => {
  it('computes round trips, winners/losers, sizes, rejections, reuse and exposure from facts', () => {
    const r = measureMultiTrade(base(), bar);
    expect(r.roundTrips).toHaveLength(2);
    expect(r.winners).toBe(1); expect(r.losers).toBe(1);
    expect(r.grossPnl).toBe(30); expect(r.feesUsd).toBeCloseTo(0.3, 6); expect(r.netPnl).toBeCloseTo(29.7, 4);
    expect(r.distinctEntrySizes).toBe(2);
    expect(r.capitalRejections).toBe(1); expect(r.cooldownRejections).toBe(1);
    expect(r.capitalReuseObserved).toBe(true);
    expect(r.maxConcurrentExposureUsd).toBe(1000);
    expect(r.failures).toEqual([]);
  });

  it('a single scripted round trip fails the multi-trade bar, and a fee-eaten gain is a net loser', () => {
    const one = base(); one.fills = one.fills.slice(0, 2); one.riskAssessments = [];
    expect(measureMultiTrade(one, bar).failures.length).toBeGreaterThanOrEqual(4);
    const tiny: MultiTradeInput = { initialCapital: 1, riskAssessments: [], fills: [
      { orderId: 'b', symbol: 'A', side: 'BUY', quantity: 1, price: 10, feeUsd: 0.1, atMs: 1 },
      { orderId: 's', symbol: 'A', side: 'SELL', quantity: 1, price: 10.1, feeUsd: 0.1, atMs: 2 },
    ] };
    const r = measureMultiTrade(tiny, { ...bar, requireNetProfitAfterCosts: true });
    expect(r.roundTrips[0].grossPnl).toBeCloseTo(0.1, 6);
    expect(r.losers).toBe(1);
    expect(r.failures.join(' ')).toMatch(/net P&L after costs/);
  });
});
