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
      publishedAt: raw.publishedAt || new Date().toISOString(),
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
