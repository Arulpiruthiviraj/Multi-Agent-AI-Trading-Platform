import { NewsProviderPlugin, NewsArticleRaw } from './NewsProviderPlugin';

export class PolygonNewsProvider implements NewsProviderPlugin {
  public id = 'polygon_news';
  public name = 'Polygon.io News';
  public type = 'API';
  public credibilityWeight = 0.88;

  async initialize() {}
  async healthCheck() { return true; }

  async fetchLatest(): Promise<NewsArticleRaw[]> {
    if (!process.env.POLYGON_API_KEY) {
      console.warn('[PolygonNewsProvider] Missing API key');
      return [];
    }

    try {
      const res = await fetch(`https://api.polygon.io/v2/reference/news?limit=10&apiKey=${process.env.POLYGON_API_KEY}`);
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
      console.error('[PolygonNewsProvider] Error fetching news', e);
      return [];
    }
  }
}
