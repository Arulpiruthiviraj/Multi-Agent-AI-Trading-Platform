import { NormalizedArticle } from './NewsNormalizer';

export class NewsDeduplicator {
  private seenFingerprints: Set<string> = new Set();
  private maxSeenCache = 10000;

  public isDuplicate(article: NormalizedArticle): boolean {
    if (this.seenFingerprints.has(article.fingerprint)) {
      return true;
    }
    
    this.seenFingerprints.add(article.fingerprint);
    
    if (this.seenFingerprints.size > this.maxSeenCache) {
      // Very naive cleanup, in production use LRU
      this.seenFingerprints.clear(); 
    }
    
    return false;
  }
}
