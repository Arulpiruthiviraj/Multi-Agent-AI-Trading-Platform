import { NewsArticleRaw } from './providers/NewsProviderPlugin';
import { v4 as uuidv4 } from 'uuid';

export interface NormalizedArticle {
  id: string;
  title: string;
  content: string;
  url: string;
  source: string;
  author: string;
  publishedAt: string;
  symbols: string[];
  fingerprint: string;
}

/**
 * 2026-10-08 defect hunt (P2-R2): normalize any provider date format to ISO at ingestion.
 * Unparseable or missing -> now (fail closed to "newest": a garbage date must never read as
 * ancient and get a fresh article pruned, nor as far-future and pin it forever).
 */
export function normalizePublishedAt(raw: string | undefined | null): string {
  if (raw) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

export class NewsNormalizer {
  public normalize(raw: NewsArticleRaw): NormalizedArticle {
    const fingerprint = this.generateFingerprint(raw.title, raw.content);
    return {
      id: raw.id || uuidv4(),
      title: raw.title.trim(),
      content: raw.content ? raw.content.trim() : '',
      url: raw.url,
      source: raw.source,
      author: raw.author || 'Unknown',
      // 2026-10-08 defect hunt (P2-R2): providers disagree on publishedAt format - RSS
      // passes raw pubDate (RFC-2822) when isoDate is absent, FMP uses "YYYY-MM-DD HH:MM:SS".
      // The news_articles retention sweep compares published_at as ISO text; non-ISO rows
      // sort after any cutoff and are NEVER pruned (leak survives the retention fix).
      // Normalize to ISO here, at ingestion. Unparseable -> now (fail closed to "newest",
      // never to a far-past date that would prune a fresh article).
      publishedAt: normalizePublishedAt(raw.publishedAt),
      symbols: raw.symbols || [],
      fingerprint
    };
  }

  private generateFingerprint(title: string, content: string) {
    // Simple fingerprinting based on normalized text
    return title.toLowerCase().replace(/[^a-z0-9]/g, '') + 
           (content ? content.substring(0, 100).toLowerCase().replace(/[^a-z0-9]/g, '') : '');
  }
}
