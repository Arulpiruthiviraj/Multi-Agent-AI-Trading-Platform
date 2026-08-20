import { describe, expect, it } from 'vitest';
import { rankCandidatesByDollarVolume } from './replayDiscoveryAdapter';
import type { ResearchBar } from '../research/ohlcvTypes';

function bar(ts: number, close: number, volume: number): ResearchBar {
  return { timestamp: ts, open: close, high: close, low: close, close, volume };
}

describe('replayDiscoveryAdapter', () => {
  it('ranks by point-in-time dollar volume without future bars', () => {
    const barsBySymbol = new Map<string, ResearchBar[]>([
      ['AAA', [bar(1000, 10, 1000), bar(2000, 10, 1000), bar(3000, 10, 1_000_000)]],
      ['BBB', [bar(1000, 20, 500), bar(2000, 20, 500), bar(3000, 20, 500)]],
    ]);
    const ranked = rankCandidatesByDollarVolume(
      { asOfMs: 2500, barsBySymbol, candidatePool: ['AAA', 'BBB'] },
      { lookbackBars: 2, minDollarVolume: 1, maxActive: 2 },
    );
    expect(ranked[0].symbol).toBe('AAA');
    expect(ranked.every((r) => r.avgDollarVolume > 0)).toBe(true);
  });
});
