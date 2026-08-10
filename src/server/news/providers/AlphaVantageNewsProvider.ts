import { NewsProviderPlugin, NewsArticleRaw } from './NewsProviderPlugin';

export class AlphaVantageNewsProvider implements NewsProviderPlugin {
  public id = 'alpha_vantage_news';
  public name = 'Alpha Vantage News';
  public type = 'API';
  public credibilityWeight = 0.85;

  async initialize() {}
  async healthCheck() { return true; }
  isConfigured() { return !!process.env.ALPHAVANTAGE_API_KEY; }

  async fetchLatest(): Promise<NewsArticleRaw[]> {
    if (!process.env.ALPHAVANTAGE_API_KEY) {
      console.warn('[AlphaVantageNewsProvider] Missing API key');
      return [];
    }

    try {
      const res = await fetch(`https://www.alphavantage.co/query?function=NEWS_SENTIMENT&limit=10&apikey=${process.env.ALPHAVANTAGE_API_KEY}`);
      if (!res.ok) return [];
      const data = await res.json();
      
      if (!data.feed) return [];
      
      return data.feed.map((item: any) => ({
        id: `av_${item.url}`,
        title: item.title,
        content: item.summary,
        source: item.source,
        author: item.authors ? item.authors.join(', ') : 'AlphaVantage',
        publishedAt: item.time_published ? new Date(item.time_published.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6Z')).toISOString() : new Date().toISOString(),
        url: item.url,
        symbols: item.ticker_sentiment ? item.ticker_sentiment.map((t: any) => t.ticker) : []
      }));
    } catch (e) {
      console.error('[AlphaVantageNewsProvider] Error fetching news', e);
      return [];
    }
  }
}
