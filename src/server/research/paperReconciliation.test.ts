import { describe, it, expect } from 'vitest';
import { reconcilePaperVsResearch } from './paperReconciliation';
import type { CanonicalBacktestResult } from './canonicalNextBarEngine';

const PAPER_ROWS_ENOUGH = Array.from({ length: 40 }, (_, i) => ({
  status: 'FILLED', side: 'SELL', profitLoss: i % 2 === 0 ? 5 : -3,
  traceId: `t${i}`, reasoning: 'test', executionEnvironment: 'PAPER',
}));

function realResearch(overrides: Partial<CanonicalBacktestResult> = {}): CanonicalBacktestResult {
  return {
    engine: 'argus_canonical_next_bar', canPlaceOrders: false, strategyId: 'X', strategyVersion: 'v1',
    datasetId: 'd', datasetHash: 'h', symbol: 'AAPL', timeframe: '1Day', dataProvider: 'alpaca',
    executionModel: 'NEXT_BAR_OPEN', executionModelVersion: 'v1', costModel: 'CONFIG', slippageModel: 'fixed',
    parametersHash: null, provenance: 'REAL' as any, quality: 'GREEN', createdAt: new Date().toISOString(),
    signalCount: 10, trades: [],
    metrics: { tradeCount: 30, sampleSize: 30, grossPnl: 100, netPnl: 90, winRate: 0.6, expectancy: 3, profitFactor: 1.5, maxDrawdown: -10, sharpe: { status: 'OK', sampleSize: 30, value: 1 }, invented: false },
    unclosedCount: 0, promotable: false, backtestPass: true, rejection: null, comparableToSameBarClose: false,
    ...overrides,
  };
}

describe('reconcilePaperVsResearch - real bug fix: malformed research record degrades honestly instead of crashing', () => {
  it('CRITICAL: a research record with .metrics undefined returns UNAVAILABLE, never throws', () => {
    const malformed = { ...realResearch(), metrics: undefined as any };
    expect(() => reconcilePaperVsResearch(malformed, PAPER_ROWS_ENOUGH)).not.toThrow();
    const result = reconcilePaperVsResearch(malformed, PAPER_ROWS_ENOUGH);
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.researchExpectancy).toBeNull();
    expect(result.invented).toBe(false);
  });

  it('a research record with metrics.expectancy missing/non-numeric also degrades honestly', () => {
    const malformed = realResearch({ metrics: { ...realResearch().metrics, expectancy: null as any } });
    const result = reconcilePaperVsResearch(malformed, PAPER_ROWS_ENOUGH);
    expect(result.status).toBe('UNAVAILABLE');
  });

  it('a real, complete research record still compares normally (no regression)', () => {
    const result = reconcilePaperVsResearch(realResearch(), PAPER_ROWS_ENOUGH);
    expect(result.status).not.toBe('UNAVAILABLE');
    expect(result.researchExpectancy).toBe(3);
  });

  it('null research (no run at all) still returns the original UNAVAILABLE path', () => {
    const result = reconcilePaperVsResearch(null, PAPER_ROWS_ENOUGH);
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.note).toMatch(/No canonical NEXT_BAR research run/);
  });
});
