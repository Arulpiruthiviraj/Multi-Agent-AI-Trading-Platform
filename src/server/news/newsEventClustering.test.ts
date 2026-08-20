import { describe, it, expect } from 'vitest';
import {
  normalizeTitleTokens,
  titleJaccardSimilarity,
  symbolsOverlap,
  findMatchingCluster,
  type ClusterCandidate,
} from './newsEventClustering';

describe('newsEventClustering (Phase F2 real event clustering match logic)', () => {
  describe('normalizeTitleTokens / titleJaccardSimilarity', () => {
    it('treats case and punctuation as irrelevant', () => {
      const a = normalizeTitleTokens('Apple Announces New AI Partnership!');
      const b = normalizeTitleTokens('apple announces new ai partnership');
      expect(titleJaccardSimilarity(a, b)).toBe(1);
    });

    it('scores partial overlap between real cross-outlet headlines about the same event', () => {
      // The exact four-headline example from the Phase F spec.
      const yahoo = normalizeTitleTokens('Apple announces new AI partnership');
      const cnbc = normalizeTitleTokens('Apple enters major AI partnership');
      const finnhub = normalizeTitleTokens('Apple AI partnership announced');
      expect(titleJaccardSimilarity(yahoo, cnbc)).toBeGreaterThan(0.3);
      expect(titleJaccardSimilarity(yahoo, finnhub)).toBeGreaterThan(0.3);
    });

    it('is honest about the limitation: a heavily-reworded headline about the same event may score low', () => {
      // "Apple signs AI deal" - real limitation documented in newsEventClustering.ts: this is a
      // pure heuristic, not semantic/embedding matching, so a rewording that shares only "apple"
      // and "ai" is not guaranteed to clear a similarity bar on title text alone. The clustering
      // system compensates with symbol+category+time as prior filters (tested separately below),
      // not by claiming title similarity alone solves this.
      const yahoo = normalizeTitleTokens('Apple announces new AI partnership');
      const reuters = normalizeTitleTokens('Apple signs AI deal');
      expect(titleJaccardSimilarity(yahoo, reuters)).toBeLessThan(0.35);
    });

    it('returns 0 for completely unrelated titles', () => {
      const a = normalizeTitleTokens('Fed raises interest rates half a point');
      const b = normalizeTitleTokens('Apple announces new AI partnership');
      expect(titleJaccardSimilarity(a, b)).toBeLessThan(0.15);
    });
  });

  describe('symbolsOverlap', () => {
    it('true when at least one symbol is shared', () => {
      expect(symbolsOverlap(['AAPL', 'MSFT'], ['AAPL'])).toBe(true);
    });
    it('false when no symbols shared, or either side is empty', () => {
      expect(symbolsOverlap(['AAPL'], ['MSFT'])).toBe(false);
      expect(symbolsOverlap([], ['AAPL'])).toBe(false);
      expect(symbolsOverlap(['AAPL'], [])).toBe(false);
    });
  });

  describe('findMatchingCluster', () => {
    const baseConfig = { timeWindowMs: 6 * 60 * 60 * 1000, titleSimilarityThreshold: 0.3 };
    const now = Date.parse('2026-08-20T12:00:00.000Z');

    function candidate(overrides: Partial<ClusterCandidate>): ClusterCandidate {
      return {
        id: 'cluster_1',
        title: 'Apple announces new AI partnership',
        eventType: 'Product',
        symbols: ['AAPL'],
        lastArticlePublishedMs: now,
        ...overrides,
      };
    }

    it('matches a corroborating article about the same event (symbol + category + time + title all pass)', () => {
      const match = findMatchingCluster(
        { title: 'Apple enters major AI partnership', eventType: 'Product', symbols: ['AAPL'], publishedMs: now + 60_000 },
        [candidate({})],
        baseConfig,
      );
      expect(match?.id).toBe('cluster_1');
    });

    it('does not match when symbols do not overlap', () => {
      const match = findMatchingCluster(
        { title: 'Apple enters major AI partnership', eventType: 'Product', symbols: ['MSFT'], publishedMs: now + 60_000 },
        [candidate({})],
        baseConfig,
      );
      expect(match).toBeNull();
    });

    it('does not match when the event category differs, even with identical symbols/title', () => {
      const match = findMatchingCluster(
        { title: 'Apple announces new AI partnership', eventType: 'Earnings', symbols: ['AAPL'], publishedMs: now + 60_000 },
        [candidate({})],
        baseConfig,
      );
      expect(match).toBeNull();
    });

    it('does not match when outside the time window', () => {
      const match = findMatchingCluster(
        { title: 'Apple enters major AI partnership', eventType: 'Product', symbols: ['AAPL'], publishedMs: now + 7 * 60 * 60 * 1000 },
        [candidate({})],
        baseConfig,
      );
      expect(match).toBeNull();
    });

    it('does not match when title similarity is below the configured threshold', () => {
      const match = findMatchingCluster(
        { title: 'Apple quarterly numbers beat expectations widely', eventType: 'Product', symbols: ['AAPL'], publishedMs: now + 60_000 },
        [candidate({})],
        baseConfig,
      );
      expect(match).toBeNull();
    });

    it('picks the single best-matching candidate when multiple qualify', () => {
      const weaker = candidate({ id: 'cluster_weak', title: 'Apple AI news today' });
      const stronger = candidate({ id: 'cluster_strong', title: 'Apple announces new AI partnership deal' });
      const match = findMatchingCluster(
        { title: 'Apple announces new AI partnership', eventType: 'Product', symbols: ['AAPL'], publishedMs: now + 60_000 },
        [weaker, stronger],
        baseConfig,
      );
      expect(match?.id).toBe('cluster_strong');
    });

    it('returns null when there are no candidates', () => {
      expect(findMatchingCluster(
        { title: 'Anything', eventType: 'Product', symbols: ['AAPL'], publishedMs: now },
        [],
        baseConfig,
      )).toBeNull();
    });
  });
});
