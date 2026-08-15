import { describe, it, expect } from 'vitest';
import { coerceEnum, clampScore, normalizeConfidence01, coerceString, coerceStringArray, TRADE_SIDE_VALUES, TRADING_BIAS_VALUES, looksLikeListedTicker, rejectIfPriceDisagrees } from './AIOutputValidator';

describe('coerceEnum', () => {
  it('matches case-insensitively', () => {
    expect(coerceEnum('buy', TRADE_SIDE_VALUES, 'HOLD')).toBe('BUY');
    expect(coerceEnum(' Sell ', TRADE_SIDE_VALUES, 'HOLD')).toBe('SELL');
    expect(coerceEnum('BULLISH', TRADING_BIAS_VALUES, 'NEUTRAL')).toBe('BULLISH');
  });

  it('falls back to the safe default for an off-schema value the model invented, never a fabricated match', () => {
    expect(coerceEnum('STRONG_BUY', TRADE_SIDE_VALUES, 'HOLD')).toBe('HOLD');
    expect(coerceEnum('maybe', TRADING_BIAS_VALUES, 'NEUTRAL')).toBe('NEUTRAL');
  });

  it('falls back for non-string/missing input', () => {
    expect(coerceEnum(undefined, TRADE_SIDE_VALUES, 'HOLD')).toBe('HOLD');
    expect(coerceEnum(null, TRADE_SIDE_VALUES, 'HOLD')).toBe('HOLD');
    expect(coerceEnum(42, TRADE_SIDE_VALUES, 'HOLD')).toBe('HOLD');
  });

  // The real bug this closes: NewsEngine.ts's `tradingBias === 'BULLISH' ? 'BUY' : 'SELL'` meant
  // any off-schema tradingBias silently became SELL. Validating tradingBias upstream to a real
  // NEUTRAL default (excluded from trade-idea emission) prevents that silent mis-mapping.
  it('never lets an invalid tradingBias resolve to BEARISH/SELL by accident', () => {
    expect(coerceEnum('POSITIVE', TRADING_BIAS_VALUES, 'NEUTRAL')).toBe('NEUTRAL');
    expect(coerceEnum('bullish!!', TRADING_BIAS_VALUES, 'NEUTRAL')).toBe('NEUTRAL');
  });
});

describe('clampScore', () => {
  it('clamps within range', () => {
    expect(clampScore(150, 0, 100, 50)).toBe(100);
    expect(clampScore(-20, 0, 100, 50)).toBe(0);
    expect(clampScore(42, 0, 100, 50)).toBe(42);
  });

  it('coerces a numeric string', () => {
    expect(clampScore('85', 0, 100, 50)).toBe(85);
  });

  it('falls back for non-numeric input', () => {
    expect(clampScore('high', 0, 100, 50)).toBe(50);
    expect(clampScore(undefined, 0, 100, 50)).toBe(50);
    expect(clampScore(NaN, 0, 100, 50)).toBe(50);
    expect(clampScore(Infinity, 0, 100, 50)).toBe(50);
  });
});

describe('normalizeConfidence01', () => {
  it('leaves an already-0-1 value unchanged', () => {
    expect(normalizeConfidence01(0.72)).toBe(0.72);
  });

  // The real bug this closes: FundamentalAgent/MacroAgent's prompt doesn't specify a scale, and a
  // model answering "confidence: 85" (thinking 0-100) would previously become idea.confidence=85,
  // trivially exceeding every real 0-1 threshold (ChiefTraderAgent's 0.6/0.75) regardless of the
  // model's actual conviction.
  it('normalizes a 0-100-scale answer down to 0-1', () => {
    expect(normalizeConfidence01(85)).toBeCloseTo(0.85);
    expect(normalizeConfidence01(100)).toBe(1);
  });

  it('clamps an out-of-range value into [0,1]', () => {
    expect(normalizeConfidence01(500)).toBe(1);
    expect(normalizeConfidence01(-5)).toBe(0);
  });

  it('falls back for non-numeric input', () => {
    expect(normalizeConfidence01('very confident')).toBe(0);
    expect(normalizeConfidence01(undefined, 0.3)).toBe(0.3);
  });
});

describe('coerceString / coerceStringArray', () => {
  it('coerceString falls back on non-string or empty', () => {
    expect(coerceString('real reasoning', 'fallback')).toBe('real reasoning');
    expect(coerceString('', 'fallback')).toBe('fallback');
    expect(coerceString(undefined, 'fallback')).toBe('fallback');
    expect(coerceString(42, 'fallback')).toBe('fallback');
  });

  it('coerceStringArray filters out non-string entries and non-arrays', () => {
    expect(coerceStringArray(['a', 'b', 3, null, 'c'])).toEqual(['a', 'b', 'c']);
    expect(coerceStringArray('not an array')).toEqual([]);
    expect(coerceStringArray(undefined)).toEqual([]);
  });
});

describe('looksLikeListedTicker (Phase 16G)', () => {
  it('accepts real listed tickers', () => {
    expect(looksLikeListedTicker('AAPL')).toBe('AAPL');
    expect(looksLikeListedTicker('nvda')).toBe('NVDA');
    expect(looksLikeListedTicker('BRK.B')).toBe('BRK.B');
  });

  it('rejects malformed company-name symbols that previously reached consensus', () => {
    expect(looksLikeListedTicker('(Coca-Cola)')).toBeNull();
    expect(looksLikeListedTicker('Apple Inc')).toBeNull();
    expect(looksLikeListedTicker('UNKNOWN')).toBeNull();
    expect(looksLikeListedTicker('')).toBeNull();
    expect(looksLikeListedTicker(null)).toBeNull();
  });
});

describe('rejectIfPriceDisagrees (Phase 16G)', () => {
  it('rejects an AI-claimed price that disagrees with live market data', () => {
    const result = rejectIfPriceDisagrees(200, 250);
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/disagrees/);
  });

  it('accepts a claim within 2% of live', () => {
    expect(rejectIfPriceDisagrees(101, 100).accepted).toBe(true);
  });

  it('rejects when there is no live price to check against, never treating the AI number as ground truth', () => {
    expect(rejectIfPriceDisagrees(200, null).accepted).toBe(false);
  });
});
