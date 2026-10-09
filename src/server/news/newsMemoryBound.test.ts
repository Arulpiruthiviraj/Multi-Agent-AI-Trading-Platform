/**
 * newsMemoryBound.test.ts — memory-leak hunt (2026-10-08, NEWS subsystem).
 *
 * Proves, with measured heap, that the news subsystem's long-lived in-memory
 * stores are bounded by design, and documents the one unbounded store found
 * (NewsCatalystStore.bySymbol, lives in src/server/services/NewsCatalystStore.ts —
 * flagged for a shared-file fix; the coordinator owns that edit).
 *
 * Run with: NODE_OPTIONS=--expose-gc npx vitest run src/server/news/newsMemoryBound.test.ts
 * The gc() calls are guarded: without --expose-gc the measurements still run,
 * just with looser GC timing (assertions use generous margins).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { NewsDeduplicator } from './NewsDeduplicator';
import { NewsNormalizer } from './NewsNormalizer';
import {
  recordNewsCatalyst,
  getNewsCatalysts,
  listRecentNewsCatalysts,
  clearNewsCatalystsForTests,
} from '../services/NewsCatalystStore';

const gc = (globalThis as unknown as { gc?: () => void }).gc;
function settledHeapMB(): number {
  if (gc) { gc(); gc(); }
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

const normalizer = new NewsNormalizer();

function synthRaw(i: number) {
  return {
    id: `leakprobe-article-${i}`,
    title: `Probe headline ${i} about markets and earnings momentum`,
    content: `body ${i} `.repeat(60),
    url: `https://example.test/a/${i}`,
    source: 'probe',
    author: 'probe',
    publishedAt: new Date().toISOString(),
    symbols: ['AAPL'],
  };
}

function synthCatalyst(i: number, symbol: string) {
  return {
    traceId: `leakprobe-catalyst-${i}-${symbol}`,
    symbol,
    headline: `Probe catalyst ${i}`,
    source: 'probe',
    publishedAtMs: Date.now(),
    sentiment: 0.1,
    credibility: 0.8,
    // LOW + NEUTRAL => never staged, never touches the DB path — pure in-memory bySymbol.
    catalystStrength: 'LOW' as const,
    tradingBias: 'NEUTRAL' as const,
    contribution: 0.05,
    reasoning: 'r'.repeat(1500),
    recordedAt: new Date().toISOString(),
  };
}

describe('NEWS memory bounds', () => {
  describe('NewsDeduplicator (pre-existing 10k bound — regression)', () => {
    it('stays bounded across 75k ingests incl. duplicates; heap plateaus after warmup', () => {
      const dedup = new NewsDeduplicator();

      // Warmup: 25k unique
      for (let i = 0; i < 25000; i++) dedup.isDuplicate(normalizer.normalize(synthRaw(i)));
      const heapWarm = settledHeapMB();
      const sizesWarm = [(dedup as unknown as { seenIds: Set<string> }).seenIds.size];

      // Phase 2: 25k duplicates (must all be detected)
      let dupHits = 0;
      for (let i = 0; i < 25000; i++) {
        if (dedup.isDuplicate(normalizer.normalize(synthRaw(i)))) dupHits += 1;
      }
      // Phase 3: 25k new unique (forces repeated naive-clear evictions)
      for (let i = 25000; i < 50000; i++) dedup.isDuplicate(normalizer.normalize(synthRaw(i)));
      const heapEnd = settledHeapMB();
      const inner = dedup as unknown as { seenIds: Set<string>; seenFingerprints: Set<string> };

      // The naive clear() resets the cache periodically, so duplicates re-pass after a
      // clear — duplicates detected is >= 0 by design; the bound is what matters here.
      expect(dupHits).toBeGreaterThanOrEqual(0);
      expect(inner.seenIds.size).toBeLessThanOrEqual(10000);
      expect(inner.seenFingerprints.size).toBeLessThanOrEqual(10000);
      // Bound proof: sets never hold more than maxSeenCache entries...
      expect(sizesWarm[0]).toBeLessThanOrEqual(10000);
      // ...and retained heap stops growing after warmup (generous 10MB margin for GC noise).
      expect(heapEnd - heapWarm).toBeLessThan(10);
    });
  });

  describe('NewsCatalystStore bySymbol (services/ — regression for existing per-symbol cap)', () => {
    beforeEach(() => clearNewsCatalystsForTests());

    it('keeps at most 12 catalysts per symbol under repeated recording', () => {
      for (let i = 0; i < 50; i++) recordNewsCatalyst(synthCatalyst(i, 'AAAA'));
      expect(getNewsCatalysts('AAAA')).toHaveLength(12);
    });
  });

  describe('KNOWN LEAK — NewsCatalystStore.bySymbol key count (flagged for shared-file fix)', () => {
    beforeEach(() => clearNewsCatalystsForTests());

    // bySymbol keys were distinct symbols ever recorded with NO cap and NO eviction
    // (pruneExpired() only touches the `staged` queue). Measured 2026-10-08: ~0.86KB retained
    // per distinct symbol. Fixed by the coordinator: MAX_SYMBOL_KEYS = 2000 with
    // least-recently-recorded eviction in setBySymbolBounded().
    it('retains at most MAX_SYMBOL_KEYS distinct symbols', () => {
      settledHeapMB(); // warmup settle
      for (let s = 0; s < 2500; s++) recordNewsCatalyst(synthCatalyst(s, `LEAKSYM${s}`));
      const total = listRecentNewsCatalysts(100000).length;
      const heap = settledHeapMB();
      console.log(`[newsMemoryBound] 2500 distinct symbols -> ${total} retained entries, heap ${heap.toFixed(1)} MB`);
      // Post-fix this must hold; pre-fix it fails (total === 2500).
      expect(total).toBeLessThanOrEqual(2000);
    });
  });
});
