import { NewsProviderPlugin, NewsArticleRaw } from './NewsProviderPlugin';

export class FMPNewsProvider implements NewsProviderPlugin {
  public id = 'fmp_news';
  public name = 'Financial Modeling Prep News';
  public type = 'API';
  public credibilityWeight = 0.86;

  async initialize() {}
  async healthCheck() { return true; }

  async fetchLatest(): Promise<NewsArticleRaw[]> {
    if (!process.env.FMP_API_KEY) {
      console.warn('[FMPNewsProvider] Missing API key');
      return [];
    }

    try {
      const res = await fetch(`https://financialmodelingprep.com/api/v3/fmp/articles?page=0&size=10&apikey=${process.env.FMP_API_KEY}`);
      if (!res.ok) return [];
      const data = await res.json();
      
      return data.content.map((item: any) => ({
        id: `fmp_${item.title}`,
        title: item.title,
        content: item.content,
        source: 'FMP',
        author: item.author || 'FMP',
        publishedAt: item.date,
        url: item.link,
        symbols: item.tickers ? item.tickers.split(',') : []
      }));
    } catch (e) {
      console.error('[FMPNewsProvider] Error fetching news', e);
      return [];
    }
  }
}
