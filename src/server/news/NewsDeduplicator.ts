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
      // Very naive cleanup, in production use LRU
      this.seenIds.clear();
      this.seenFingerprints.clear();
    }

    return false;
  }
}
