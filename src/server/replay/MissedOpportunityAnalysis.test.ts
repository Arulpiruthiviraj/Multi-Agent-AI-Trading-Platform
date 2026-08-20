import { describe, it, expect } from 'vitest';
import type { ResearchBar } from '../research/ohlcvTypes';
import { analyzeMissedOpportunities } from './MissedOpportunityAnalysis';

function bar(timestamp: number, o: number, h: number, l: number, c: number): ResearchBar {
  return { timestamp, open: o, high: h, low: l, close: c, volume: 1000 } as ResearchBar;
}

describe('analyzeMissedOpportunities', () => {
  it('classifies MISSED_OPPORTUNITY when the price rallies past the favorable-move threshold after rejection', () => {
    const bars = new Map([
      ['XYZ', [
        bar(1, 10, 10, 10, 10), // rejection bar (timestamp=1, referencePrice=10)
        bar(2, 10, 11, 10, 11),
        bar(3, 11, 12, 11, 12),
        bar(4, 12, 20, 12, 20), // +100% high - clearly a miss
      ]],
    ]);
    const result = analyzeMissedOpportunities(
      [{ symbol: 'XYZ', timestamp: 1, reason: 'NO_CHIEF_APPROVAL', referencePrice: 10 }],
      bars,
      { horizonBars: 3, favorableMovePct: 5 },
    );
    expect(result).toHaveLength(1);
    expect(result[0].classification).toBe('MISSED_OPPORTUNITY');
    expect(result[0].maxFavorableExcursionPct).toBeCloseTo(100, 0);
    expect(result[0].label).toBe('AFTER-THE-FACT ANALYSIS');
  });

  it('classifies CORRECTLY_AVOIDED when the price never clears the favorable-move threshold', () => {
    const bars = new Map([
      ['FLAT', [
        bar(1, 10, 10, 10, 10),
        bar(2, 10, 10.1, 9.9, 10),
        bar(3, 10, 10.2, 9.8, 10),
        bar(4, 10, 10.1, 9.9, 10),
      ]],
    ]);
    const result = analyzeMissedOpportunities(
      [{ symbol: 'FLAT', timestamp: 1, reason: 'NO_CHIEF_APPROVAL', referencePrice: 10 }],
      bars,
      { horizonBars: 3, favorableMovePct: 5 },
    );
    expect(result[0].classification).toBe('CORRECTLY_AVOIDED');
  });

  it('classifies INCONCLUSIVE when fewer bars exist after rejection than the configured horizon', () => {
    const bars = new Map([
      ['THIN', [bar(1, 10, 10, 10, 10), bar(2, 10, 50, 10, 50)]], // only 1 bar after t=1, horizon wants 5
    ]);
    const result = analyzeMissedOpportunities(
      [{ symbol: 'THIN', timestamp: 1, reason: 'NO_CHIEF_APPROVAL', referencePrice: 10 }],
      bars,
      { horizonBars: 5, favorableMovePct: 5 },
    );
    expect(result[0].classification).toBe('INCONCLUSIVE');
  });

  it('classifies INCONCLUSIVE (not a crash) when no bars exist after the rejection at all', () => {
    const bars = new Map([['NOFUTURE', [bar(1, 10, 10, 10, 10)]]]);
    const result = analyzeMissedOpportunities(
      [{ symbol: 'NOFUTURE', timestamp: 1, reason: 'NO_CHIEF_APPROVAL', referencePrice: 10 }],
      bars,
    );
    expect(result[0].classification).toBe('INCONCLUSIVE');
    expect(result[0].barsAvailableAfterRejection).toBe(0);
  });

  it('excludes the bar exactly at the rejection timestamp (strictly-after cutoff, not on-or-after)', () => {
    const bars = new Map([
      ['ORDER', [
        bar(1, 10, 999, 10, 999), // same timestamp as the rejection - must be excluded even though its high looks like a huge move
        bar(2, 10, 11, 10, 11),
      ]],
    ]);
    const result = analyzeMissedOpportunities(
      [{ symbol: 'ORDER', timestamp: 1, reason: 'NO_CHIEF_APPROVAL', referencePrice: 10 }],
      bars,
      { horizonBars: 1, favorableMovePct: 5 },
    );
    // Only the timestamp=2 bar (high=11) should count, not the timestamp=1 bar (high=999).
    expect(result[0].maxFavorableExcursionPct).toBeCloseTo(10, 0);
  });
});
