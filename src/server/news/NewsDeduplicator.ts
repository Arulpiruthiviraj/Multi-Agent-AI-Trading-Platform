import { NormalizedArticle } from './NewsNormalizer';

export class NewsDeduplicator {
  // 2026-10-12 defect hunt (news L13): keyed on the (id, content-version) composite. The
  // provider-native article id alone let a corrected re-issued article under the same id
  // slip through as a duplicate, so the correction was never reprocessed. NormalizedArticle
  // carries no separate contentVersion field - its `fingerprint` IS the content version
  // (generateFingerprint over normalized title + content), so (id, fingerprint) is the
  // composite. An identical re-issue (same id, same fingerprint) is still a duplicate;
  // same id with a changed fingerprint is reprocessed. Note the fingerprint is computed
  // over normalized text, so a provider refetch that only differs in whitespace maps to
  // the same fingerprint and stays deduped (the 2026-10-08 D1 concern that keyed on id).
  private seenComposite: Set<string> = new Set();
  private maxSeenCache = 10000;

  public isDuplicate(article: NormalizedArticle): boolean {
    const key = compositeKey(article.id, article.fingerprint);
    if (this.seenComposite.has(key)) {
      return true;
    }

    this.seenComposite.add(key);

    if (this.seenComposite.size > this.maxSeenCache) {
      // 2026-10-08 defect hunt (news D1): the old wholesale clear() made every article "new"
      // again on the next cycle - a full re-processing storm (normalize, credibility, classify,
      // symbol extraction, and a sequential FinBERT HTTP call per article) every ~10-20 min of
      // RTH, blocking subsequent polls via pipelineInFlight. Evict the oldest ~10% instead
      // (insertion-ordered Set iteration = oldest first), same pattern as FingerprintMemory.
      // Evicted-but-persisted articles are still caught by the DB-level onConflictDoNothing
      // backstop in createOrUpdateCluster and the pre-FinBERT existence check in NewsEngine.
      evictOldest(this.seenComposite, this.maxSeenCache);
    }

    return false;
  }
}

/** Composite dedup key: the same article id re-issued with a new content fingerprint. */
function compositeKey(id: string, fingerprint: string): string {
  return `${id}\u0000${fingerprint}`;
}

/** Deletes the oldest ~10% of an insertion-ordered set (oldest entries iterate first). */
function evictOldest(set: Set<string>, cap: number): void {
  let n = Math.max(1, Math.floor(cap / 10));
  for (const oldest of set) {
    set.delete(oldest);
    if (--n <= 0) break;
  }
}
