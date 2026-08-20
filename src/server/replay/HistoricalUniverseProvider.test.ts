import { describe, it, expect } from 'vitest';
import type { ResearchBar } from '../research/ohlcvTypes';
import { getHistoricalDiscoveryUniverse, screenHistoricalCandidates } from './HistoricalUniverseProvider';
import { replaySafety } from './replaySafety';

function bar(timestamp: number, close: number, volume: number): ResearchBar {
  return { timestamp, open: close, high: close, low: close, close, volume } as ResearchBar;
}

describe('getHistoricalDiscoveryUniverse', () => {
  it('returns the configured static candidate list, and a fresh array each call', () => {
    const a = getHistoricalDiscoveryUniverse();
    const b = getHistoricalDiscoveryUniverse();
    expect(a).toEqual(replaySafety.historicalDiscoveryUniverse);
    expect(a).not.toBe(replaySafety.historicalDiscoveryUniverse); // caller cannot mutate the config
    expect(a).toEqual(b);
  });
});

describe('screenHistoricalCandidates - look-ahead correctness', () => {
  it('never uses a bar at or after t - a future high-volume bar cannot qualify a symbol early', () => {
    const barsBySymbol = new Map<string, ResearchBar[]>([
      ['THIN', [
        bar(1, 100, 100), bar(2, 100, 100), bar(3, 100, 100), // low volume, visible
        bar(10, 100, 999999999), // huge volume, but AT/AFTER t=5 - must not count
      ]],
    ]);
    const result = screenHistoricalCandidates(['THIN'], barsBySymbol, 5, {
      lookbackBars: 3, minDollarVolume: 50000, maxActive: 5,
    });
    // Only bars 1-3 are visible at t=5 (avg dollar volume 10,000 - below the 50,000 floor).
    // If the future t=10 bar (volume 999,999,999) were incorrectly included, this would pass.
    expect(result.find((r) => r.symbol === 'THIN')).toBeUndefined();
  });

  it('excludes a symbol with fewer visible bars than lookbackBars, rather than zero-filling', () => {
    const barsBySymbol = new Map<string, ResearchBar[]>([
      ['NEW', [bar(1, 100, 1000000), bar(2, 100, 1000000)]], // only 2 bars, lookback needs 3
    ]);
    const result = screenHistoricalCandidates(['NEW'], barsBySymbol, 5, {
      lookbackBars: 3, minDollarVolume: 1000, maxActive: 5,
    });
    expect(result).toEqual([]);
  });
});

describe('screenHistoricalCandidates - liquidity screen', () => {
  it('excludes symbols below minDollarVolume', () => {
    const barsBySymbol = new Map<string, ResearchBar[]>([
      ['ILLIQUID', [bar(1, 10, 100), bar(2, 10, 100), bar(3, 10, 100)]], // $1000/bar avg
      ['LIQUID', [bar(1, 100, 100000), bar(2, 100, 100000), bar(3, 100, 100000)]], // $10M/bar avg
    ]);
    const result = screenHistoricalCandidates(['ILLIQUID', 'LIQUID'], barsBySymbol, 4, {
      lookbackBars: 3, minDollarVolume: 1_000_000, maxActive: 5,
    });
    expect(result.map((r) => r.symbol)).toEqual(['LIQUID']);
  });

  it('ranks by average dollar volume descending and caps at maxActive', () => {
    const barsBySymbol = new Map<string, ResearchBar[]>([
      ['LOW', [bar(1, 100, 20000), bar(2, 100, 20000)]],
      ['MID', [bar(1, 100, 50000), bar(2, 100, 50000)]],
      ['HIGH', [bar(1, 100, 100000), bar(2, 100, 100000)]],
    ]);
    const result = screenHistoricalCandidates(['LOW', 'MID', 'HIGH'], barsBySymbol, 3, {
      lookbackBars: 2, minDollarVolume: 0, maxActive: 2,
    });
    expect(result.map((r) => r.symbol)).toEqual(['HIGH', 'MID']); // LOW excluded by the cap
  });

  it('only averages the trailing lookbackBars window, not the full visible history', () => {
    const barsBySymbol = new Map<string, ResearchBar[]>([
      // Old bars have huge volume, recent bars are thin - lookback=2 should only see the thin tail.
      ['DECAYING', [bar(1, 100, 999999999), bar(2, 100, 999999999), bar(3, 100, 100), bar(4, 100, 100)]],
    ]);
    const result = screenHistoricalCandidates(['DECAYING'], barsBySymbol, 5, {
      lookbackBars: 2, minDollarVolume: 1_000_000, maxActive: 5,
    });
    expect(result).toEqual([]); // trailing 2 bars average $10k/bar, below the $1M floor
  });
});
