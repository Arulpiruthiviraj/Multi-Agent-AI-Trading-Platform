import { NewsProviderPlugin, NewsArticleRaw } from './NewsProviderPlugin';
import { logErrorSafely } from '../../core/SecretRedaction';

export class PolygonNewsProvider implements NewsProviderPlugin {
  public id = 'polygon_news';
  public name = 'Polygon.io News';
  public type = 'API';
  public credibilityWeight = 0.88;

  async initialize() {}
  async healthCheck() { return true; }
  isConfigured() { return !!process.env.POLYGON_API_KEY; }

  async fetchLatest(): Promise<NewsArticleRaw[]> {
    if (!process.env.POLYGON_API_KEY) {
      console.warn('[PolygonNewsProvider] Missing API key');
      return [];
    }

    try {
      // Hardening pass, Phase 8: Polygon.io's real API supports header-based auth
      // (Authorization: Bearer), unlike AlphaVantage/FMP - moved off key-in-query-string entirely
      // rather than relying on redaction alone, since a header never appears in the request URL a
      // caught fetch error might otherwise expose.
      const res = await fetch('https://api.polygon.io/v2/reference/news?limit=10', {
        headers: { Authorization: `Bearer ${process.env.POLYGON_API_KEY}` },
      });
      if (!res.ok) return [];
      const data = await res.json();
      
      if (!data.results) return [];
      
      return data.results.map((item: any) => ({
        id: `poly_${item.id}`,
        title: item.title,
        content: item.description,
        source: item.publisher?.name || 'Polygon',
        author: item.author || 'Polygon',
        publishedAt: item.published_utc,
        url: item.article_url,
        symbols: item.tickers || []
      }));
    } catch (e) {
      // Defense-in-depth even though the key is no longer in the URL - consistent with every
      // other provider's error logging, see SecretRedaction.ts.
      logErrorSafely('[PolygonNewsProvider] Error fetching news', e);
      return [];
    }
  }
}
