import { describe, it, expect } from 'vitest';
import type { ResearchBar } from '../research/ohlcvTypes';
import type { StoredThesis } from '../quant/analysis/ThesisInvalidation';
import { checkThesisInvalidation } from './FullArgusReplayEngine';
import { MIN_BARS } from '../quant/RegimeEngine';

function bar(i: number, close: number): ResearchBar {
  return { timestamp: i, open: close, high: close + 1, low: close - 1, close, volume: 100000 } as ResearchBar;
}

const bullishThesis: StoredThesis = {
  texts: ['Price closes back below the broken level.'],
  strategy: 'MOMENTUM_BREAKOUT',
  side: 'BUY',
  entryRegime: 'BULLISH_TREND',
  applicableRegimes: ['BULLISH_TREND'],
  structuralLevel: 100,
};

describe('checkThesisInvalidation (replay wiring around the real evaluateThesisInvalidation)', () => {
  it('short-circuits to not-invalidated when no thesis was captured at BUY time (e.g. golden-schedule fixture entries)', () => {
    const bars = Array.from({ length: MIN_BARS + 5 }, (_, i) => bar(i, 100 + i));
    const result = checkThesisInvalidation(null, bars);
    expect(result).toEqual({ invalidated: false, reasons: [] });
  });

  it('runs the real evaluateThesisInvalidation against real classifyRegime/computeVolumeFeatures output without throwing, on a rising price series', () => {
    const bars = Array.from({ length: MIN_BARS + 10 }, (_, i) => bar(i, 100 + i * 2));
    const result = checkThesisInvalidation(bullishThesis, bars);
    expect(typeof result.invalidated).toBe('boolean');
    expect(Array.isArray(result.reasons)).toBe(true);
  });

  it('runs without throwing on a falling price series (a real regime flip is plausible but not asserted, since classifyRegime internals are not this test\'s concern)', () => {
    const bars = Array.from({ length: MIN_BARS + 10 }, (_, i) => bar(i, 200 - i * 3));
    const result = checkThesisInvalidation(bullishThesis, bars);
    expect(typeof result.invalidated).toBe('boolean');
  });

  it('does not throw on a too-thin bar series (below MIN_BARS)', () => {
    const bars = [bar(1, 100), bar(2, 101)];
    const result = checkThesisInvalidation(bullishThesis, bars);
    expect(typeof result.invalidated).toBe('boolean');
  });
});
