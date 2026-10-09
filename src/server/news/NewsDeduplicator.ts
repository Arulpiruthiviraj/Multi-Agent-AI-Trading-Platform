import { NormalizedArticle } from './NewsNormalizer';

export class NewsDeduplicator {
  // Keyed on the provider-native article id (stable across refetches of the same story) - the
  // content fingerprint alone let re-fetched copies of the same article through when a provider
  // returned slightly different title/content whitespace between polls, which was silently
  // re-running AI analysis and hitting the news_articles.id UNIQUE constraint every ~10s cycle.
  private seenIds: Set<string> = new Set();
  private seenFingerprints: Set<string> = new Set();
  private maxSeenCache = 10000;

  public isDuplicate(article: NormalizedArticle): boolean {
    if (this.seenIds.has(article.id) || this.seenFingerprints.has(article.fingerprint)) {
      return true;
    }

    this.seenIds.add(article.id);
    this.seenFingerprints.add(article.fingerprint);

    if (this.seenIds.size > this.maxSeenCache) {
      // 2026-10-08 defect hunt (news D1): the old wholesale clear() made every article "new"
      // again on the next cycle - a full re-processing storm (normalize, credibility, classify,
      // symbol extraction, and a sequential FinBERT HTTP call per article) every ~10-20 min of
      // RTH, blocking subsequent polls via pipelineInFlight. Evict the oldest ~10% instead
      // (insertion-ordered Set iteration = oldest first), same pattern as FingerprintMemory.
      // Evicted-but-persisted articles are still caught by the DB-level onConflictDoNothing
      // backstop in createOrUpdateCluster and the pre-FinBERT existence check in NewsEngine.
      evictOldest(this.seenIds, this.maxSeenCache);
      evictOldest(this.seenFingerprints, this.maxSeenCache);
    }

    return false;
  }
}

/** Deletes the oldest ~10% of an insertion-ordered set (oldest entries iterate first). */
function evictOldest(set: Set<string>, cap: number): void {
  let n = Math.max(1, Math.floor(cap / 10));
  for (const oldest of set) {
    set.delete(oldest);
    if (--n <= 0) break;
  }
}
