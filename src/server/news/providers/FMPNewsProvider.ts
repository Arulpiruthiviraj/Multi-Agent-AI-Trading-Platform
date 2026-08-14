import { NewsProviderPlugin, NewsArticleRaw } from './NewsProviderPlugin';
import { logErrorSafely } from '../../core/SecretRedaction';

export class FMPNewsProvider implements NewsProviderPlugin {
  public id = 'fmp_news';
  public name = 'Financial Modeling Prep News';
  public type = 'API';
  public credibilityWeight = 0.86;

  async initialize() {}
  async healthCheck() { return true; }
  isConfigured() { return !!process.env.FMP_API_KEY; }

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
      // FMP's API only supports key-in-query-string auth (no header alternative) - see
      // AlphaVantageNewsProvider.ts's identical comment / SecretRedaction.ts.
      logErrorSafely('[FMPNewsProvider] Error fetching news', e);
      return [];
    }
  }
}
