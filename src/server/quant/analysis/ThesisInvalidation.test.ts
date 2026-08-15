import { describe, it, expect } from 'vitest';
import { evaluateThesisInvalidation, parseStoredThesis, serializeStoredThesis, StoredThesis } from './ThesisInvalidation';
import { Bar } from '../../engines/backtest/HistoricalDataGateway';

function bar(close: number, extras: Partial<Bar> = {}): Bar {
  return { timestamp: 1, open: close, high: close + 1, low: close - 1, close, volume: 100, ...extras };
}

const momentumBuy: StoredThesis = {
  texts: ['Price closes back below the broken level (false breakout).', 'RVOL drops back below 1.2x average on the follow-through bar(s).', 'Market regime flips away from BULLISH_TREND.'],
  strategy: 'MOMENTUM_BREAKOUT',
  side: 'BUY',
  entryRegime: 'BULLISH_TREND',
  applicableRegimes: ['BULLISH_TREND'],
  structuralLevel: 100,
};

describe('evaluateThesisInvalidation', () => {
  it('does not invalidate while regime, RVOL, and structure still match the original thesis', () => {
    const result = evaluateThesisInvalidation(momentumBuy, {
      regime: 'BULLISH_TREND',
      rvol: 1.8,
      adx: 28,
      structureEvent: 'NONE',
      structureTrend: 'UPTREND',
      lastClose: 105,
      bars: [bar(101), bar(102), bar(105)],
    });
    expect(result.invalidated).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it('invalidates on a real regime flip away from applicableRegimes', () => {
    const result = evaluateThesisInvalidation(momentumBuy, {
      regime: 'BEARISH_TREND',
      rvol: 1.8,
      adx: 28,
      structureEvent: 'NONE',
      structureTrend: 'DOWNTREND',
      lastClose: 105,
      bars: [bar(105)],
    });
    expect(result.invalidated).toBe(true);
    expect(result.reasons[0]).toMatch(/regime flipped/i);
  });

  it('invalidates when RVOL collapses below 1.2x on a momentum breakout', () => {
    const result = evaluateThesisInvalidation(momentumBuy, {
      regime: 'BULLISH_TREND',
      rvol: 0.9,
      adx: 28,
      structureEvent: 'NONE',
      structureTrend: 'UPTREND',
      lastClose: 105,
      bars: [bar(105)],
    });
    expect(result.invalidated).toBe(true);
    expect(result.reasons[0]).toMatch(/RVOL collapsed/);
  });

  it('invalidates TREND_FOLLOWING when ADX fades below 20', () => {
    const result = evaluateThesisInvalidation({
      texts: ['ADX falls below 20'],
      strategy: 'TREND_FOLLOWING',
      side: 'BUY',
      entryRegime: 'BULLISH_TREND',
      applicableRegimes: ['BULLISH_TREND'],
      structuralLevel: null,
    }, {
      regime: 'BULLISH_TREND',
      rvol: 1.5,
      adx: 14,
      structureEvent: 'NONE',
      structureTrend: 'UPTREND',
      lastClose: 110,
      bars: [],
    });
    expect(result.invalidated).toBe(true);
    expect(result.reasons[0]).toMatch(/ADX faded/);
  });

  it('round-trips serialize/parse without fabricating fields', () => {
    const json = serializeStoredThesis(momentumBuy);
    expect(parseStoredThesis(json)).toEqual(momentumBuy);
    expect(parseStoredThesis(null)).toBeNull();
    expect(parseStoredThesis('not-json')).toBeNull();
  });
});
