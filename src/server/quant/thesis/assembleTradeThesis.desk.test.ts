import { describe, it, expect } from 'vitest';
import { assembleTradeThesis } from './assembleTradeThesis';
import { baseFixture } from '../strategies/testHelpers';

describe('assembleTradeThesis desk fields', () => {
  it('always lists reasons NOT to trade even on a candidate', () => {
    const ctx = baseFixture();
    const thesis = assembleTradeThesis({
      symbol: ctx.symbol,
      ctx,
      evaluation: {
        strategy: 'MOMENTUM_BREAKOUT',
        side: 'BUY',
        setupScore: 80,
        confidence: 0.8,
        conditionsMet: ['BOS'],
        conditionsFailed: ['RVOL'],
        contradictions: ['Below VWAP'],
        invalidationConditions: ['Close back inside range'],
        stop: { price: 95, basis: 'test' },
        target: { price: 110, basis: 'test' },
        applicableRegimes: ['BULLISH_TREND'],
      },
      ideaSide: 'BUY',
      reasonsNotToTrade: ['Below VWAP', 'Unmet: RVOL'],
    });
    expect(thesis.reasonsNotToTrade.length).toBeGreaterThan(0);
    expect(thesis.numericEvidenceSource).toBe('quant_engines');
  });
});
