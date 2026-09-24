import { describe, it, expect } from 'vitest';
import { classifyCommission, worstCostQuality, buildTradeCostBreakdown } from './canonicalCostModel';
import type { ExecutionQualityRow } from './executionQuality';

function row(overrides: Partial<ExecutionQualityRow> = {}): ExecutionQualityRow {
  return {
    orderId: 'o1', symbol: 'AAPL', side: 'BUY', status: 'FILLED',
    arrivalPrice: 100, avgFillPrice: 101, filledQuantity: 10,
    slippagePerShare: 1, slippageBps: 100,
    submittedAt: null, firstFillAt: null, submissionToFirstFillMs: null,
    quantStrategyId: null, executionEnvironment: 'PAPER', evidenceClass: 'PAPER_ORGANIC',
    brokerId: 'alpaca', rawCommission: null, grossPnl: null, decisionTimestamp: '2026-09-23T00:00:00Z',
    traceId: null, regime: null, hadPartialFill: false,
    ...overrides,
  };
}

describe('worstCostQuality', () => {
  it('returns UNAVAILABLE for an empty list rather than throwing or defaulting to MEASURED', () => {
    expect(worstCostQuality([])).toBe('UNAVAILABLE');
  });

  it('picks the least-certain quality among components, never the best', () => {
    expect(worstCostQuality(['MEASURED', 'UNAVAILABLE'])).toBe('UNAVAILABLE');
    expect(worstCostQuality(['MEASURED', 'ESTIMATED', 'PARTIAL'])).toBe('PARTIAL');
    expect(worstCostQuality(['MEASURED', 'MEASURED'])).toBe('MEASURED');
  });
});

describe('classifyCommission', () => {
  it('uses a real reported commission when present, regardless of broker', () => {
    const result = classifyCommission({ brokerId: 'ibkr_gateway', symbol: 'AAPL', rawCommission: 1.25 });
    expect(result).toEqual({ commissionTotal: 1.25, commissionQuality: 'MEASURED' });
  });

  it('classifies Alpaca US equity orders as a real, verified $0 commission fact, not a guess', () => {
    const result = classifyCommission({ brokerId: 'alpaca', symbol: 'AAPL', rawCommission: null });
    expect(result).toEqual({ commissionTotal: 0, commissionQuality: 'MEASURED' });
  });

  it('does NOT apply the Alpaca zero-commission exception to a crypto symbol', () => {
    const result = classifyCommission({ brokerId: 'alpaca', symbol: 'BTC/USD', rawCommission: null });
    expect(result).toEqual({ commissionTotal: null, commissionQuality: 'UNAVAILABLE' });
  });

  it('reports UNAVAILABLE, never zero, for an unknown broker with no reported commission', () => {
    const result = classifyCommission({ brokerId: 'ibkr_gateway', symbol: 'AAPL', rawCommission: null });
    expect(result).toEqual({ commissionTotal: null, commissionQuality: 'UNAVAILABLE' });
  });

  it('reports UNAVAILABLE for a null brokerId with no reported commission', () => {
    const result = classifyCommission({ brokerId: null, symbol: 'AAPL', rawCommission: null });
    expect(result).toEqual({ commissionTotal: null, commissionQuality: 'UNAVAILABLE' });
  });
});

describe('buildTradeCostBreakdown', () => {
  it('combines real slippage with a real MEASURED commission into a real total cost', () => {
    const breakdown = buildTradeCostBreakdown(row({ brokerId: 'ibkr_gateway', rawCommission: 5, filledQuantity: 10, slippagePerShare: 1, arrivalPrice: 100 }));
    expect(breakdown.slippageQuality).toBe('MEASURED');
    expect(breakdown.commissionQuality).toBe('MEASURED');
    expect(breakdown.commissionTotal).toBe(5);
    expect(breakdown.totalCostQuality).toBe('MEASURED');
    // slippagePerShare(1) + commissionPerShare(5/10=0.5) = 1.5 per share
    expect(breakdown.totalCostPerShare).toBeCloseTo(1.5, 6);
    expect(breakdown.totalCostBps).toBeCloseTo((1.5 / 100) * 10000, 6);
  });

  it('leaves totalCost null (never a partial estimate) when commission is UNAVAILABLE', () => {
    const breakdown = buildTradeCostBreakdown(row({ brokerId: 'ibkr_gateway', rawCommission: null }));
    expect(breakdown.commissionQuality).toBe('UNAVAILABLE');
    expect(breakdown.totalCostQuality).toBe('UNAVAILABLE');
    expect(breakdown.totalCostPerShare).toBeNull();
    expect(breakdown.totalCostBps).toBeNull();
    // Slippage itself is still reported - it just can't be combined into a real total yet.
    expect(breakdown.slippagePerShare).toBe(1);
  });

  it('produces a real MEASURED total for the verified Alpaca-equity-zero-commission case', () => {
    const breakdown = buildTradeCostBreakdown(row({ brokerId: 'alpaca', symbol: 'AAPL', rawCommission: null, slippagePerShare: 0.5, arrivalPrice: 200 }));
    expect(breakdown.commissionTotal).toBe(0);
    expect(breakdown.totalCostQuality).toBe('MEASURED');
    expect(breakdown.totalCostPerShare).toBeCloseTo(0.5, 6);
  });
});
