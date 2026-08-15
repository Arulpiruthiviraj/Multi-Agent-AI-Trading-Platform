import { describe, it, expect } from 'vitest';
import { assembleTradeThesis } from './assembleTradeThesis';
import { baseFixture } from '../strategies/testHelpers';
import { evaluateAll } from '../strategies/StrategyEngine';
import { noTradeReasonsConfig } from '../../config/noTradeReasons';

describe('assembleTradeThesis', () => {
  it('marks HOLD as NO_TRADE using the configured first-class reason list', () => {
    const ctx = baseFixture();
    const thesis = assembleTradeThesis({
      symbol: ctx.symbol,
      ctx,
      evaluation: null,
      ideaSide: 'HOLD',
    });
    expect(thesis.direction).toBe('NO_TRADE');
    expect(thesis.finalDecision).toBe('NO_TRADE');
    expect(thesis.numericEvidenceSource).toBe('quant_engines');
    expect(noTradeReasonsConfig.reasons.map(r => r.code)).toContain(thesis.noTrade?.code);
  });

  it('copies stop/target from a strategy evaluation and does not invent EV', () => {
    const ctx = baseFixture();
    const evaluation = evaluateAll(ctx)[0];
    evaluation.stop = { price: 95, basis: 'test' };
    evaluation.target = { price: 110, basis: 'test' };
    const thesis = assembleTradeThesis({
      symbol: ctx.symbol,
      ctx,
      evaluation,
      ideaSide: 'BUY',
      expectedValueR: null,
    });
    expect(thesis.direction).toBe('LONG');
    expect(thesis.entry).toBe(ctx.currentPrice);
    expect(thesis.stop).toBe(95);
    expect(thesis.target).toBe(110);
    expect(thesis.expectedRewardRisk).toBeCloseTo(2, 8);
    expect(thesis.estimatedExpectedValue).toBeNull();
  });
});
