import { describe, it, expect } from 'vitest';
import { Bar } from '../engines/backtest/HistoricalDataGateway';
import { classifyRegime, classifyDeskSession } from './RegimeEngine';

function bar(i: number, close: number, rangePct = 0.01): Bar {
  return {
    timestamp: i * 86_400_000,
    open: close, close,
    high: close * (1 + rangePct), low: close * (1 - rangePct),
    volume: 1_000_000,
  };
}

describe('RegimeEngine.classifyRegime', () => {
  it('classifies a real, clean, sustained uptrend as BULLISH_TREND with real trendStrength/confidence', () => {
    // 220 bars of steady, real upward drift - enough real history for SMA200/DMI/ADX to all agree.
    const bars: Bar[] = Array.from({ length: 220 }, (_, i) => bar(i, 100 + i * 0.5));
    const result = classifyRegime(bars);

    expect(result.regime).toBe('BULLISH_TREND');
    expect(result.trendStrength).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.insufficientData).toBe(false);
  });

  it('classifies a real, clean, sustained downtrend as BEARISH_TREND', () => {
    const bars: Bar[] = Array.from({ length: 220 }, (_, i) => bar(i, 300 - i * 0.5));
    const result = classifyRegime(bars);

    expect(result.regime).toBe('BEARISH_TREND');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('classifies a real flat/choppy series as SIDEWAYS_RANGE', () => {
    // 200 bars alternating +1/-1 around 100 (zero net drift, flat SMAs, low ADX since direction
    // reverses every bar) followed by 20 bars settled exactly at 100 - representing price
    // currently sitting at the middle of its range, not at one extreme of the alternation. An
    // earlier version of this fixture ended mid-alternation (on a "down" tick), which left price
    // sitting a real, meaningful 1% below the (correctly) flat moving averages purely because of
    // where the array happened to stop - a fixture artifact, not a real trend signal; this
    // version removes that bias.
    const oscillating: Bar[] = Array.from({ length: 200 }, (_, i) => bar(i, 100 + (i % 2 === 0 ? 1 : -1)));
    const settled: Bar[] = Array.from({ length: 20 }, (_, i) => bar(200 + i, 100));
    const result = classifyRegime([...oscillating, ...settled]);

    expect(result.regime).toBe('SIDEWAYS_RANGE');
  });

  it('reports HIGH volatility for a real, sharply-widened recent range vs. the symbol\'s own calm history', () => {
    const calmBars: Bar[] = Array.from({ length: 200 }, (_, i) => bar(i, 100 + i * 0.05, 0.002));
    const volatileBars: Bar[] = Array.from({ length: 20 }, (_, i) => bar(200 + i, 110, 0.06));
    const result = classifyRegime([...calmBars, ...volatileBars]);
    expect(result.volatility).toBe('HIGH');
  });

  it('flags insufficientData honestly on a thin bar array rather than pretending full confidence', () => {
    const bars: Bar[] = Array.from({ length: 10 }, (_, i) => bar(i, 100 + i));
    const result = classifyRegime(bars);
    expect(result.insufficientData).toBe(true);
  });

  it('marketStructure is TRENDING for a real strong-ADX trend, matching AdvancedQuantEngines\' own adx>25 convention', () => {
    const bars: Bar[] = Array.from({ length: 220 }, (_, i) => bar(i, 100 + i * 0.6));
    const result = classifyRegime(bars);
    expect(result.marketStructure).toBe('TRENDING');
  });

  it('confidence reflects real signal agreement - a unanimous multi-feature read beats a mixed one', () => {
    const strongUptrend: Bar[] = Array.from({ length: 220 }, (_, i) => bar(i, 100 + i * 0.5));
    const choppyMix: Bar[] = Array.from({ length: 220 }, (_, i) => bar(i, 100 + (i % 2 === 0 ? 1 : -1)));

    const strong = classifyRegime(strongUptrend);
    const choppy = classifyRegime(choppyMix);

    expect(strong.confidence).toBeGreaterThan(choppy.confidence);
  });
});

describe('RegimeEngine.classifyDeskSession', () => {
  // 2026-08-27 is a Thursday, 2026-08-29 a Saturday, 2026-08-30 a Sunday; EDT is UTC-4 that week.
  function etOn(dateIso: string, hh: number, mm: number): Date {
    return new Date(`${dateIso}T${String(hh + 4).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`);
  }

  it('classifies a weekday morning correctly (unaffected by the weekend fix)', () => {
    const result = classifyDeskSession('NORMAL', 'RANGING', etOn('2026-08-27', 10, 0));
    expect(result.phase).toBe('MORNING');
  });

  it('weekend-awareness fix: a Saturday at a normal RTH morning clock-time is UNKNOWN, not misclassified as an intraday phase', () => {
    const result = classifyDeskSession('NORMAL', 'RANGING', etOn('2026-08-29', 10, 0));
    expect(result.phase).toBe('UNKNOWN');
    expect(result.source).toMatch(/weekend/i);
  });

  it('weekend-awareness fix: a Sunday at a normal RTH afternoon clock-time is also UNKNOWN', () => {
    const result = classifyDeskSession('NORMAL', 'RANGING', etOn('2026-08-30', 14, 0));
    expect(result.phase).toBe('UNKNOWN');
    expect(result.source).toMatch(/weekend/i);
  });
});
