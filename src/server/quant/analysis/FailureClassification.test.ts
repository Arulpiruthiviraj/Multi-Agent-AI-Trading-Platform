import { describe, it, expect } from 'vitest';
import { classifyTradeFailure, computeFailureBreakdown, FailureClassificationInput } from './FailureClassification';

function baseInput(overrides: Partial<FailureClassificationInput> = {}): FailureClassificationInput {
  return {
    entryRegime: 'BULLISH_TREND',
    applicableRegimes: ['BULLISH_TREND', 'BEARISH_TREND'],
    entryContradictions: [],
    rMultiple: -0.3,
    entrySlippagePct: 0.001,
    exitSlippagePct: 0.001,
    ...overrides,
  };
}

describe('classifyTradeFailure', () => {
  it('classifies BAD_REGIME when the entry regime is outside the strategy\'s applicable regimes', () => {
    const result = classifyTradeFailure(baseInput({ entryRegime: 'SIDEWAYS_RANGE', applicableRegimes: ['BULLISH_TREND'] }));
    expect(result.category).toBe('BAD_REGIME');
  });

  it('classifies SIGNAL_CONFLICT when real internal contradictions were recorded at entry', () => {
    const result = classifyTradeFailure(baseInput({ entryContradictions: ['bullish momentum but price below VWAP'] }));
    expect(result.category).toBe('SIGNAL_CONFLICT');
    expect(result.detail).toContain('VWAP');
  });

  it('classifies STOP_LOSS_HIT when the trade closed near or beyond -1R', () => {
    const result = classifyTradeFailure(baseInput({ rMultiple: -0.95 }));
    expect(result.category).toBe('STOP_LOSS_HIT');
  });

  it('classifies SLIPPAGE_DRAG when combined entry+exit slippage is material and nothing else applies', () => {
    const result = classifyTradeFailure(baseInput({ rMultiple: -0.1, entrySlippagePct: 0.008, exitSlippagePct: 0.006 }));
    expect(result.category).toBe('SLIPPAGE_DRAG');
  });

  it('falls back to UNKNOWN rather than force-fitting a category - honest, not fabricated', () => {
    const result = classifyTradeFailure(baseInput({ rMultiple: -0.1, entrySlippagePct: 0.0005, exitSlippagePct: 0.0005 }));
    expect(result.category).toBe('UNKNOWN');
  });

  it('checks BAD_REGIME before SIGNAL_CONFLICT when both are present (fixed priority order, deterministic)', () => {
    const result = classifyTradeFailure(baseInput({
      entryRegime: 'SIDEWAYS_RANGE', applicableRegimes: ['BULLISH_TREND'],
      entryContradictions: ['something'],
    }));
    expect(result.category).toBe('BAD_REGIME');
  });
});

describe('computeFailureBreakdown', () => {
  it('only counts SELL trades with a real negative realizedPnl as losses', () => {
    const tradeLog = [
      { side: 'BUY', realizedPnl: undefined },
      { side: 'SELL', realizedPnl: 50, failureCategory: undefined }, // a win - not a loss
      { side: 'SELL', realizedPnl: -20, failureCategory: 'STOP_LOSS_HIT' },
      { side: 'SELL', realizedPnl: -30, failureCategory: 'STOP_LOSS_HIT' },
      { side: 'SELL', realizedPnl: -10, failureCategory: 'BAD_REGIME' },
    ];
    const breakdown = computeFailureBreakdown(tradeLog as any);
    expect(breakdown.totalLosses).toBe(3);
    expect(breakdown.byCategory.STOP_LOSS_HIT.count).toBe(2);
    expect(breakdown.byCategory.STOP_LOSS_HIT.pctOfLosses).toBeCloseTo(66.7, 1);
    expect(breakdown.byCategory.BAD_REGIME.count).toBe(1);
  });

  it('returns an empty, honest breakdown when there are no losses', () => {
    const breakdown = computeFailureBreakdown([{ side: 'SELL', realizedPnl: 50 }] as any);
    expect(breakdown.totalLosses).toBe(0);
    expect(breakdown.byCategory).toEqual({});
  });
});
