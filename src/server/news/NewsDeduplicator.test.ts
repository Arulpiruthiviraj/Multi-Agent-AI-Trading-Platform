import { describe, it, expect } from 'vitest';
import { NewsDeduplicator } from './NewsDeduplicator';

/**
 * Real defect (2026-10-08 defect hunt, news D1): when seenIds exceeded 10,000, the
 * deduplicator wiped BOTH sets wholesale. Every article in every feed was then "new"
 * again on the next cycle and re-ran the full local path - including a sequential
 * FinBERT HTTP call per article - before the DB-level backstop skipped it, recurring
 * every ~10-20 min of RTH and stalling the pipeline heartbeat. Now evicts oldest ~10%
 * (LRU) instead of clearing.
 */
describe('NewsDeduplicator bounded eviction (D1)', () => {
  const article = (id: string) => ({
    id,
    title: `title ${id}`,
    content: `content ${id}`,
    url: `https://x/${id}`,
    source: 'test',
    author: 'a',
    publishedAt: new Date().toISOString(),
    symbols: [],
    fingerprint: `fp-${id}`,
  });

  it('never wholesale-clears: recent articles stay recognized as duplicates past the cap', () => {
    const dedup = new NewsDeduplicator();
    const N = 10_500;
    for (let i = 0; i < N; i++) {
      expect(dedup.isDuplicate(article(`a-${i}`))).toBe(false);
    }
    // The old clear() would have wiped everything at 10,001; a recent article must
    // still be recognized. (The very oldest ~10% were evicted by design.)
    expect(dedup.isDuplicate(article(`a-${N - 1}`))).toBe(true);
    expect(dedup.isDuplicate(article(`a-${N - 100}`))).toBe(true);
    // Size stays bounded near the cap, not reset to ~0 and not growing unbounded.
    const size = (dedup as any).seenComposite.size as number;
    expect(size).toBeLessThanOrEqual(10_500);
    expect(size).toBeGreaterThan(9_000);
  });

  it('evicts the oldest entries first (insertion order)', () => {
    const dedup = new NewsDeduplicator();
    for (let i = 0; i < 10_001; i++) {
      dedup.isDuplicate(article(`b-${i}`));
    }
    // b-0..b-~1000 were the oldest and should be evicted; b-9000 must survive.
    expect(dedup.isDuplicate(article('b-0'))).toBe(false); // re-added as "new" (evicted)
    expect(dedup.isDuplicate(article('b-9000'))).toBe(true);
  });
});

/**
 * 2026-10-12 defect hunt (news L13): the dedup key is the (id, content-fingerprint)
 * composite. A corrected re-issued article under the SAME id must be reprocessed when
 * its fingerprint changes; an identical re-issue must stay deduped.
 */
describe('NewsDeduplicator corrected re-issue (L13)', () => {
  const mk = (id: string, fingerprint: string) => ({
    id,
    title: `title ${id}`,
    content: `content ${id}`,
    url: `https://x/${id}`,
    source: 'test',
    author: 'a',
    publishedAt: new Date().toISOString(),
    symbols: [],
    fingerprint,
  });

  it('reprocesses the same article id when the content fingerprint changes (correction)', () => {
    const dedup = new NewsDeduplicator();
    expect(dedup.isDuplicate(mk('a-1', 'fp-v1'))).toBe(false); // first sighting: new
    expect(dedup.isDuplicate(mk('a-1', 'fp-v1'))).toBe(true); // identical re-issue: dup
    expect(dedup.isDuplicate(mk('a-1', 'fp-v2'))).toBe(false); // corrected re-issue: reprocessed
    expect(dedup.isDuplicate(mk('a-1', 'fp-v2'))).toBe(true); // now the correction is known
  });

  it('still dedupes an identical re-issue under the same id', () => {
    const dedup = new NewsDeduplicator();
    expect(dedup.isDuplicate(mk('a-2', 'fp-same'))).toBe(false);
    expect(dedup.isDuplicate(mk('a-2', 'fp-same'))).toBe(true);
    expect(dedup.isDuplicate(mk('a-2', 'fp-same'))).toBe(true);
  });

  it('does not cross-dedupe: same fingerprint under a different id is a different article', () => {
    const dedup = new NewsDeduplicator();
    expect(dedup.isDuplicate(mk('a-3', 'fp-x'))).toBe(false);
    expect(dedup.isDuplicate(mk('a-4', 'fp-x'))).toBe(false);
  });

  it('does not cross-dedupe: same id with different fingerprints are distinct versions', () => {
    const dedup = new NewsDeduplicator();
    expect(dedup.isDuplicate(mk('a-5', 'fp-1'))).toBe(false);
    // A second, different content version is new work, not a repeat of fp-1.
    expect(dedup.isDuplicate(mk('a-5', 'fp-2'))).toBe(false);
  });
});
