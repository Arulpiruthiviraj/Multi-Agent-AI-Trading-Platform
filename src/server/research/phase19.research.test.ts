import { describe, it, expect } from 'vitest';
import { relativeVolume } from '../quant/indicators/volume';
import { keltnerChannels } from '../quant/indicators/volatility';
import { coreParityVector, nextOpenFillStats, vectorsMatch } from './coreParityVectors';
import { compareEngines } from './VectorBTService';
import { cleanOhlcv } from './ingestAlpacaWarehouse';
import { assessDataQuality } from './dataQuality';
import { reconstructPitDebate } from '../engines/backtest/PitLlmReplay';
import { evaluatePitAiBuyGate } from '../engines/backtest/PitReplay';
import { loadStrategySpec } from './strategySpecs';
import { replayArgusStrategy } from './argusStrategyReplay';
import { loadGoldenSmaDataset } from './loadGoldenDataset';
import { tradingSafety } from '../config/tradingSafety';
import type { ResearchBar } from './ohlcvTypes';

function barsFromCloses(closes: number[]): ResearchBar[] {
  return closes.map((c, i) => ({
    timestamp: i * 86400000,
    open: c,
    high: c + 1,
    low: c - 1,
    close: c,
    volume: i === closes.length - 1 ? 200 : 10,
  }));
}

describe('Phase 19 hygiene and CORE feature translation', () => {
  it('does not confuse paper seed cash with order-notional fallback', () => {
    expect(tradingSafety.internalPaperDefaultCash).toBe(100000);
    expect(tradingSafety.defaultMaxTradeSizeDollars).toBe(3000);
    expect(tradingSafety.internalPaperDefaultCash).not.toBe(tradingSafety.defaultMaxTradeSizeDollars);
  });

  it('CORE spec is FEATURE_SUBSET_PARITY for BOS/RVOL/Keltner/S-R vectors, not an SMA proxy', () => {
    const spec = loadStrategySpec('MOMENTUM_BREAKOUT') as any;
    expect(spec.vectorbtParity).toBe('FEATURE_SUBSET_PARITY');
    expect(spec.sourceFile).toContain('momentumBreakout.ts');
  });

  it('SMC remains PROXY_NOT_FEATURE_PARITY / UNVALIDATED', () => {
    const spec = loadStrategySpec('SMC_LIQUIDITY_SWEEP') as any;
    expect(spec.vectorbtParity).toBe('PROXY_NOT_FEATURE_PARITY');
  });

  it('RVOL matches TS volume engine (not a fabricated series)', () => {
    const volumes = [...Array(20).fill(10), 20];
    expect(relativeVolume(volumes)).toBe(2);
  });

  it('Keltner is EMA±2*ATR from the same TechnicalIndicators formulas', () => {
    const highs = Array.from({ length: 30 }, (_, i) => 11 + i * 0.01);
    const lows = highs.map((h) => h - 2);
    const closes = highs.map((h) => h - 1);
    const k = keltnerChannels(highs, lows, closes);
    expect(k).not.toBeNull();
    expect(k!.upper).toBeGreaterThan(k!.middle);
    expect(k!.lower).toBeLessThan(k!.middle);
  });

  it('parity vector is stable and next-open fills compare with zero ENGINE_MISMATCH on identical signals', () => {
    const bars = barsFromCloses(Array.from({ length: 40 }, (_, i) => 100 + (i % 3)));
    const a = coreParityVector(bars);
    const b = coreParityVector(bars);
    expect(vectorsMatch(a, b)).toBe(true);
    const buys = bars.map((_, i) => i % 10 === 0);
    const ts = nextOpenFillStats(bars, buys);
    const vbt = nextOpenFillStats(bars, buys);
    expect(compareEngines(ts, vbt).status).toBe('PASS');
  });

  it('Argus CORE replay on golden fixture stays INSUFFICIENT_SAMPLE; vector adapter is FEATURE_SUBSET_PARITY', () => {
    const ds = loadGoldenSmaDataset();
    const r = replayArgusStrategy({ strategyId: 'MOMENTUM_BREAKOUT', bars: ds.bars, provenance: ds.provenance ?? 'UNIT_FIXTURE' });
    expect(r.vectorbtParity).toBe('FEATURE_SUBSET_PARITY');
    expect(r.rejection).toBe('INSUFFICIENT_SAMPLE');
    expect(r.canPlaceOrders).toBe(false);
  });

  it('warehouse cleaner drops invalid OHLC and quality RED refuses parquet semantics', () => {
    const cleaned = cleanOhlcv([
      { timestamp: 2, open: 2, high: 3, low: 1, close: 2, volume: 1 },
      { timestamp: 1, open: 1, high: 1, low: 2, close: 1, volume: 1 },
      { timestamp: 2, open: 2.5, high: 3, low: 2, close: 2.2, volume: 1 },
    ]);
    expect(cleaned.cleaned).toHaveLength(1);
    expect(cleaned.cleaned[0].open).toBe(2.5);
    expect(cleaned.droppedBarCount).toBeGreaterThan(0);
    const red = assessDataQuality({
      schemaVersion: 1, datasetId: 'x', symbol: 'SPY', timezone: 'America/New_York', frequency: '1Day',
      adjustmentPolicy: 'raw', missingBarPolicy: 'drop', duplicatePolicy: 'keep_last', source: 'test',
      sourceVersion: '1', market: 'US', bars: [], provenance: 'UNIT_FIXTURE',
    });
    expect(red.quality).toBe('RED');
    expect(red.backtestAllowed).toBe(false);
  });

  it('PIT debateReplayed is true only with stored prompt, completion, and news at asOf', () => {
    const asOf = Date.parse('2026-01-02T00:00:00.000Z');
    const miss = reconstructPitDebate({ asOfMs: asOf, symbol: 'SPY', aiCalls: [], newsClusters: [] });
    expect(miss.debateReplayed).toBe(false);
    const hit = reconstructPitDebate({
      asOfMs: asOf,
      symbol: 'SPY',
      aiCalls: [{
        prompt: 'debate SPY',
        rawResponse: '{"side":"HOLD"}',
        status: 'success',
        createdAt: '2026-01-01T12:00:00.000Z',
        agent: 'ChiefTrader',
      }],
      newsClusters: [{ createdAt: '2026-01-01T11:00:00.000Z', symbols: '["SPY"]', title: 'CPI' }],
    });
    expect(hit.debateReplayed).toBe(true);
    const future = reconstructPitDebate({
      asOfMs: asOf,
      symbol: 'SPY',
      aiCalls: [{
        prompt: 'late',
        rawResponse: '{}',
        status: 'success',
        createdAt: '2026-01-03T00:00:00.000Z',
        agent: 'ChiefTrader',
      }],
      newsClusters: [{ createdAt: '2026-01-01T11:00:00.000Z', symbols: '["SPY"]', title: 'CPI' }],
    });
    expect(future.debateReplayed).toBe(false);
  });

  it('evaluatePitAiBuyGate flips debateReplayed only via reconstruction', () => {
    const asOf = Date.parse('2026-01-02T00:00:00.000Z');
    const gate = evaluatePitAiBuyGate(
      [{ kind: 'CHIEF_TRADER', agent: 'ChiefTrader', side: 'HOLD', confidence: 0.2, publishedAtMs: asOf }],
      'SPY',
      100,
      {
        asOfMs: asOf,
        aiCalls: [{ prompt: 'p', rawResponse: 'r', status: 'success', createdAt: '2026-01-01T00:00:00.000Z', agent: 'ChiefTrader' }],
        newsClusters: [{ createdAt: '2026-01-01T00:00:00.000Z', symbols: 'SPY', title: 'n' }],
      },
    );
    expect(gate.replay?.debateReplayed).toBe(true);
  });
});
