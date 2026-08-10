import { NewsProviderPlugin, NewsArticleRaw } from './NewsProviderPlugin';

export class FinnhubNewsProvider implements NewsProviderPlugin {
  public id = 'finnhub_market';
  public name = 'Finnhub Market News';
  public type = 'API';
  public credibilityWeight = 0.90;

  async initialize() {}
  async healthCheck() { return true; }
  isConfigured() { return !!process.env.FINNHUB_API_KEY; }

  async fetchLatest(): Promise<NewsArticleRaw[]> {
    if (!process.env.FINNHUB_API_KEY) {
      return [];
    }

    try {
      const res = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${process.env.FINNHUB_API_KEY}`);
      if (!res.ok) return [];
      const data = await res.json();
      
      return data.slice(0, 10).map((item: any) => ({
        id: `finnhub_${item.id}`,
        title: item.headline,
        content: item.summary,
        source: item.source,
        author: 'Finnhub',
        publishedAt: new Date(item.datetime * 1000).toISOString(),
        url: item.url,
        symbols: []
      }));
    } catch (e) {
      console.error('[FinnhubNewsProvider] Error fetching news', e);
      return [];
    }
  }
}
