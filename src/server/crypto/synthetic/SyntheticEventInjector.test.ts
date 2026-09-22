import { describe, it, expect } from 'vitest';
import { SyntheticRandom } from '../../replay/synthetic/SyntheticRandom';
import { scheduleEvent, applyEventToBars, type SyntheticMarketEvent } from './SyntheticEventInjector';
import { generateSyntheticCryptoPricePath, generateBtcFactorReturns } from './SyntheticCryptoPriceProcess';
import { generateRegimePath } from './SyntheticCryptoRegimeStateMachine';
import type { SyntheticCryptoAsset } from './SyntheticCryptoAssetTypes';

function testBars() {
  const totalBars = 100;
  const asset: SyntheticCryptoAsset = {
    syntheticSymbol: 'SYNTEST001', assetId: 'x', baseAsset: 'X', quoteAsset: 'USD',
    liquidityBucket: 'MID_CAP', volatilityBucket: 'MODERATE', correlationCluster: 'L1',
    behavioralArchetype: 'TRENDING', initialPrice: 100, btcFactorLoading: 0.8,
    listingBarIndex: 0, delistingBarIndex: null, baseVolatilityPerBar: 0.01, baseSpreadPct: 0.001,
  };
  const regimePath = generateRegimePath(new SyntheticRandom(1), totalBars, 'RANGE');
  const btcReturns = generateBtcFactorReturns(new SyntheticRandom(2), regimePath, 0.02);
  return generateSyntheticCryptoPricePath(asset, regimePath, btcReturns, new SyntheticRandom(3), 0, 60_000);
}

describe('scheduleEvent', () => {
  it('produces a start index that leaves room for the full duration within totalBars', () => {
    const event = scheduleEvent(new SyntheticRandom(1), 'SYNTEST001', 'FLASH_CRASH', 100, 10);
    expect(event.startBarIndex).toBeGreaterThanOrEqual(0);
    expect(event.startBarIndex + event.durationBars).toBeLessThanOrEqual(100);
  });

  it('severity is always within [0,1]-adjacent bounds actually used (0.3-1.0 by construction)', () => {
    const event = scheduleEvent(new SyntheticRandom(2), 'SYNTEST001', 'GAP', 100, 5);
    expect(event.severity).toBeGreaterThanOrEqual(0.3);
    expect(event.severity).toBeLessThanOrEqual(1.0);
  });
});

describe('applyEventToBars', () => {
  const bars = testBars();

  function eventAt(type: SyntheticMarketEvent['type'], start: number, duration: number): SyntheticMarketEvent {
    return { eventId: 'e1', assetSymbol: 'SYNTEST001', startBarIndex: start, durationBars: duration, type, severity: 0.8, seed: 1 };
  }

  it('never mutates the input array', () => {
    const original = bars.map((b) => ({ ...b }));
    applyEventToBars(bars, eventAt('FLASH_CRASH', 20, 5));
    expect(bars).toEqual(original);
  });

  it('FLASH_CRASH lowers close prices within the event window', () => {
    const faulted = applyEventToBars(bars, eventAt('FLASH_CRASH', 20, 5));
    expect(faulted[24].close).toBeLessThan(bars[24].close);
  });

  it('FLASH_PUMP raises close prices within the event window', () => {
    const faulted = applyEventToBars(bars, eventAt('FLASH_PUMP', 20, 5));
    expect(faulted[24].close).toBeGreaterThan(bars[24].close);
  });

  it('MISSING_BARS removes exactly the bars in the event window', () => {
    const faulted = applyEventToBars(bars, eventAt('MISSING_BARS', 30, 5));
    expect(faulted).toHaveLength(bars.length - 5);
  });

  it('DUPLICATE_BARS produces one extra bar with a repeated timestamp', () => {
    const faulted = applyEventToBars(bars, eventAt('DUPLICATE_BARS', 10, 1));
    expect(faulted).toHaveLength(bars.length + 1);
    expect(faulted[10].timestampMs).toBe(faulted[11].timestampMs);
  });

  it('OUT_OF_ORDER_BARS swaps the timestamps at the start and end of the window', () => {
    const faulted = applyEventToBars(bars, eventAt('OUT_OF_ORDER_BARS', 10, 5));
    expect(faulted[10].timestampMs).toBe(bars[14].timestampMs);
    expect(faulted[14].timestampMs).toBe(bars[10].timestampMs);
  });

  it('STALE_QUOTE freezes close price for the whole window at the pre-event value', () => {
    const faulted = applyEventToBars(bars, eventAt('STALE_QUOTE', 40, 5));
    for (let i = 40; i < 45; i++) {
      expect(faulted[i].close).toBe(bars[40].close);
    }
  });

  it('VOLUME_SPIKE increases volume within the window without changing price', () => {
    const faulted = applyEventToBars(bars, eventAt('VOLUME_SPIKE', 15, 5));
    expect(faulted[17].volume).toBeGreaterThan(bars[17].volume);
    expect(faulted[17].close).toBe(bars[17].close);
  });

  it('an event scheduled past the end of the series is a safe no-op', () => {
    const faulted = applyEventToBars(bars, eventAt('FLASH_CRASH', 10_000, 5));
    expect(faulted).toEqual(bars);
  });
});
