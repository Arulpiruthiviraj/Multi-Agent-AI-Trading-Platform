import { describe, it, expect } from 'vitest';
import { SyntheticRandom } from '../../replay/synthetic/SyntheticRandom';
import { generateBtcFactorReturns, generateSyntheticCryptoPricePath } from './SyntheticCryptoPriceProcess';
import { generateRegimePath } from './SyntheticCryptoRegimeStateMachine';
import type { SyntheticCryptoAsset } from './SyntheticCryptoAssetTypes';

function baseAsset(overrides: Partial<SyntheticCryptoAsset>): SyntheticCryptoAsset {
  return {
    syntheticSymbol: 'SYNTEST001',
    assetId: 'synthetic-test-1',
    baseAsset: 'TEST1',
    quoteAsset: 'USD',
    liquidityBucket: 'MID_CAP',
    volatilityBucket: 'MODERATE',
    correlationCluster: 'L1',
    behavioralArchetype: 'TRENDING',
    initialPrice: 10,
    btcFactorLoading: 0.8,
    listingBarIndex: 0,
    delistingBarIndex: null,
    baseVolatilityPerBar: 0.015,
    baseSpreadPct: 0.001,
    ...overrides,
  };
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  const meanA = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const meanB = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  return cov / Math.sqrt(varA * varB);
}

function closesToLogReturns(bars: { close: number }[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i++) out.push(Math.log(bars[i].close / bars[i - 1].close));
  return out;
}

describe('SyntheticCryptoPriceProcess', () => {
  const totalBars = 1000;
  const regimePath = generateRegimePath(new SyntheticRandom(1), totalBars, 'RANGE');
  const btcReturns = generateBtcFactorReturns(new SyntheticRandom(2), regimePath, 0.02);

  it('is deterministic given the same asset, regime path, factor returns, and RNG seed', () => {
    const asset = baseAsset({});
    const a = generateSyntheticCryptoPricePath(asset, regimePath, btcReturns, new SyntheticRandom(999), 0, 60_000);
    const b = generateSyntheticCryptoPricePath(asset, regimePath, btcReturns, new SyntheticRandom(999), 0, 60_000);
    expect(a).toEqual(b);
  });

  it('produces exactly one bar per index in [listingBarIndex, totalBars) when never delisted', () => {
    const asset = baseAsset({ listingBarIndex: 0, delistingBarIndex: null });
    const bars = generateSyntheticCryptoPricePath(asset, regimePath, btcReturns, new SyntheticRandom(1), 0, 60_000);
    expect(bars).toHaveLength(totalBars);
    expect(bars[0].barIndex).toBe(0);
    expect(bars[bars.length - 1].barIndex).toBe(totalBars - 1);
  });

  it('respects listingBarIndex - no bars exist before an asset is listed', () => {
    const asset = baseAsset({ listingBarIndex: 700 });
    const bars = generateSyntheticCryptoPricePath(asset, regimePath, btcReturns, new SyntheticRandom(1), 0, 60_000);
    expect(bars).toHaveLength(totalBars - 700);
    expect(bars[0].barIndex).toBe(700);
  });

  it('respects delistingBarIndex - no bars exist after an asset delists', () => {
    const asset = baseAsset({ delistingBarIndex: 300 });
    const bars = generateSyntheticCryptoPricePath(asset, regimePath, btcReturns, new SyntheticRandom(1), 0, 60_000);
    expect(bars).toHaveLength(300);
    expect(bars[bars.length - 1].barIndex).toBe(299);
  });

  it('every bar respects high >= max(open,close) and low <= min(open,close)', () => {
    const asset = baseAsset({});
    const bars = generateSyntheticCryptoPricePath(asset, regimePath, btcReturns, new SyntheticRandom(1), 0, 60_000);
    for (const bar of bars) {
      expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close));
      expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close));
      expect(bar.volume).toBeGreaterThanOrEqual(0);
    }
  });

  it('price never goes to exactly zero or negative regardless of drawdown severity', () => {
    const crashRegime = new Array(500).fill('CRASH') as ReturnType<typeof generateRegimePath>;
    const crashBtcReturns = generateBtcFactorReturns(new SyntheticRandom(3), crashRegime, 0.05);
    const asset = baseAsset({ initialPrice: 1 });
    const bars = generateSyntheticCryptoPricePath(asset, crashRegime, crashBtcReturns, new SyntheticRandom(3), 0, 60_000);
    for (const bar of bars) {
      expect(bar.close).toBeGreaterThan(0);
      expect(bar.low).toBeGreaterThan(0);
    }
  });

  it('a high BTC-factor-loading asset correlates with the BTC return series more strongly than a low-loading asset', () => {
    const highLoading = baseAsset({ btcFactorLoading: 1.3, syntheticSymbol: 'SYNHIGH' });
    const lowLoading = baseAsset({ btcFactorLoading: 0.05, syntheticSymbol: 'SYNLOW' });

    const highBars = generateSyntheticCryptoPricePath(highLoading, regimePath, btcReturns, new SyntheticRandom(50), 0, 60_000);
    const lowBars = generateSyntheticCryptoPricePath(lowLoading, regimePath, btcReturns, new SyntheticRandom(51), 0, 60_000);

    const highReturns = closesToLogReturns(highBars);
    const lowReturns = closesToLogReturns(lowBars);

    const highCorr = Math.abs(pearson(highReturns, btcReturns.slice(1)));
    const lowCorr = Math.abs(pearson(lowReturns, btcReturns.slice(1)));

    expect(highCorr).toBeGreaterThan(lowCorr);
  });

  it('a RANDOM archetype asset shows near-zero correlation with the BTC factor return series', () => {
    const randomAsset = baseAsset({ behavioralArchetype: 'RANDOM', btcFactorLoading: 1.0, syntheticSymbol: 'SYNRAND' });
    const bars = generateSyntheticCryptoPricePath(randomAsset, regimePath, btcReturns, new SyntheticRandom(77), 0, 60_000);
    const returns = closesToLogReturns(bars);
    const corr = Math.abs(pearson(returns, btcReturns.slice(1)));
    expect(corr).toBeLessThan(0.15);
  });

  it('changing bars after a given index does not change bars at or before that index (no-lookahead, verified by truncation equivalence)', () => {
    const asset = baseAsset({});
    const fullRegime = generateRegimePath(new SyntheticRandom(1), 500, 'RANGE');
    const fullBtc = generateBtcFactorReturns(new SyntheticRandom(2), fullRegime, 0.02);
    const truncatedRegime = fullRegime.slice(0, 200);
    const truncatedBtc = fullBtc.slice(0, 200);

    const fullBars = generateSyntheticCryptoPricePath(asset, fullRegime, fullBtc, new SyntheticRandom(999), 0, 60_000);
    const truncatedBars = generateSyntheticCryptoPricePath(asset, truncatedRegime, truncatedBtc, new SyntheticRandom(999), 0, 60_000);

    expect(truncatedBars).toEqual(fullBars.slice(0, 200));
  });
});
