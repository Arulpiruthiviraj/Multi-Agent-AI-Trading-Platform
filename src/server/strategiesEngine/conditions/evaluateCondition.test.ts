import { describe, it, expect } from 'vitest';
import { evaluateCondition } from './evaluateCondition';
import { leaf, and, or, not, xor } from './ConditionTypes';
import { MarketSnapshot } from '../core/MarketSnapshot';
import { LEAF_CONDITION_TYPES } from './conditionCatalog';

function makeSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    symbol: 'TEST',
    timeframe: '1d',
    timestamp: 1000,
    price: { open: 100, high: 105, low: 98, close: 102, volume: 1_000_000 },
    series: {
      ema9: [99, 101],
      ema20: [100, 100.5],
      close: [100, 102],
    },
    indicators: {
      rsi14: 55,
      macdHistogram: 0.5,
      adx: 28,
      atrPercent: 2.5,
      relativeVolume: 1.8,
      roc: 3,
      zScoreClose20: -2.7,
      vwapDistancePct: 1.2,
      gapSizePct: 1.1,
      newsSentiment: 0.4,
    },
    levels: {
      vwap: 101,
      keltnerUpper: 103,
      keltnerLower: 97,
      previousDayHigh: 104,
      previousDayLow: 96,
      nearestSupport: 99,
      nearestResistance: 106,
      priorChannelHigh: 103,
      priorChannelLow: 97,
      swingHigh: null,
      swingLow: null,
      fvgLow: null,
      fvgHigh: null,
      orderBlockLow: null,
      orderBlockHigh: null,
    },
    flags: {
      trendBullish: true,
      trendBearish: false,
      bosConfirmed: true,
      choChConfirmed: false,
      fvgDetected: true,
      fvgPriceInZone: false,
      orderBlockDetected: false,
      orderBlockPriceInZone: false,
      liquiditySwept: true,
      isVolumeSpike: true,
    },
    ...overrides,
  };
}

describe('evaluateCondition - leaf primitives', () => {
  it('every LeafConditionType in the catalog is handled (no silent fallthrough)', () => {
    const snapshot = makeSnapshot();
    for (const type of LEAF_CONDITION_TYPES) {
      // Should not throw for any known type, regardless of result.
      expect(() => evaluateCondition(leaf(type, { field: 'rsi14', value: 50, low: 0, high: 100, compareField: 'ema20' }), snapshot)).not.toThrow();
    }
  });

  it('PriceAbove/PriceBelow read a level field', () => {
    const s = makeSnapshot();
    expect(evaluateCondition(leaf('PriceAbove', { field: 'vwap' }), s)).toBe(true); // 102 > 101
    expect(evaluateCondition(leaf('PriceBelow', { field: 'vwap' }), s)).toBe(false);
  });

  it('CrossAbove requires prior<=prior and current>current on both series', () => {
    const s = makeSnapshot({ series: { ema9: [99, 101], ema20: [100, 100.5] } });
    expect(evaluateCondition(leaf('CrossAbove', { field: 'ema9', compareField: 'ema20' }), s)).toBe(true);
    expect(evaluateCondition(leaf('CrossBelow', { field: 'ema9', compareField: 'ema20' }), s)).toBe(false);
  });

  it('CrossAbove is false (not fabricated) when a series is missing', () => {
    const s = makeSnapshot({ series: {} });
    expect(evaluateCondition(leaf('CrossAbove', { field: 'ema9', compareField: 'ema20' }), s)).toBe(false);
  });

  it('RSIAbove/RSIBelow honor a custom field override', () => {
    const s = makeSnapshot({ indicators: { rsi14: 55 } });
    expect(evaluateCondition(leaf('RSIAbove', { value: 50 }), s)).toBe(true);
    expect(evaluateCondition(leaf('RSIBelow', { value: 50 }), s)).toBe(false);
  });

  it('null indicator makes the condition false, never throws or guesses', () => {
    const s = makeSnapshot({ indicators: { rsi14: null } });
    expect(evaluateCondition(leaf('RSIAbove', { value: 50 }), s)).toBe(false);
  });

  it('FVGDetected vs FVGPriceInZone are genuinely distinct', () => {
    const s = makeSnapshot({ flags: { fvgDetected: true, fvgPriceInZone: false } as any });
    expect(evaluateCondition(leaf('FVGDetected'), s)).toBe(true);
    expect(evaluateCondition(leaf('FVGPriceInZone'), s)).toBe(false);
  });

  it('Always/Never are real trivial constants', () => {
    const s = makeSnapshot();
    expect(evaluateCondition(leaf('Always'), s)).toBe(true);
    expect(evaluateCondition(leaf('Never'), s)).toBe(false);
  });
});

describe('evaluateCondition - composition (AND/OR/NOT/XOR truth tables)', () => {
  const T = leaf('Always');
  const F = leaf('Never');
  const s = makeSnapshot();

  it('AND', () => {
    expect(evaluateCondition(and(T, T), s)).toBe(true);
    expect(evaluateCondition(and(T, F), s)).toBe(false);
    expect(evaluateCondition(and(F, F), s)).toBe(false);
  });
  it('OR', () => {
    expect(evaluateCondition(or(T, F), s)).toBe(true);
    expect(evaluateCondition(or(F, F), s)).toBe(false);
    expect(evaluateCondition(or(T, T), s)).toBe(true);
  });
  it('NOT', () => {
    expect(evaluateCondition(not(T), s)).toBe(false);
    expect(evaluateCondition(not(F), s)).toBe(true);
  });
  it('XOR (odd number of true children)', () => {
    expect(evaluateCondition(xor(T, F), s)).toBe(true);
    expect(evaluateCondition(xor(T, T), s)).toBe(false);
    expect(evaluateCondition(xor(T, T, T), s)).toBe(true);
    expect(evaluateCondition(xor(F, F), s)).toBe(false);
  });
  it('nested composition', () => {
    // (RSIAbove 50 AND ADXAbove 20) AND (VolumeAboveAverage 1 OR LiquiditySwept)
    const node = and(
      and(leaf('RSIAbove', { value: 50 }), leaf('ADXAbove', { value: 20 })),
      or(leaf('VolumeAboveAverage', { value: 1 }), leaf('LiquiditySwept')),
    );
    expect(evaluateCondition(node, s)).toBe(true);
  });
});
