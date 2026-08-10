import { NewsProviderPlugin } from './providers/NewsProviderPlugin';
import { RssNewsProvider } from './providers/RssNewsProvider';
import { FinnhubNewsProvider } from './providers/FinnhubNewsProvider';
import { AlphaVantageNewsProvider } from './providers/AlphaVantageNewsProvider';
import { PolygonNewsProvider } from './providers/PolygonNewsProvider';
import { FMPNewsProvider } from './providers/FMPNewsProvider';
import { db } from '../db';
import * as schema from '../db/schema';
import { eq } from 'drizzle-orm';
import { eventBus } from '../core/EventBus';

export interface ProviderStats {
  lastFetchAt: string | null;
  lastSuccessAt: string | null;
  lastArticleCount: number;
  errorCount: number;
  lastError: string | null;
}

export class NewsProviderManager {
  private providers: Map<string, NewsProviderPlugin> = new Map();
  // Real per-provider fetch stats, updated on every fetchAllLatest() cycle - not fabricated.
  private stats: Map<string, ProviderStats> = new Map();

  constructor() {
    this.registerProvider(new RssNewsProvider('yahoo_finance', 'Yahoo Finance', 'https://finance.yahoo.com/news/rssindex', 0.9));
    this.registerProvider(new RssNewsProvider('cnbc_top', 'CNBC Top News', 'https://search.cnbc.com/rs/search/combinedcms/view.xml?profile=120000000&id=100003114', 0.85));
    this.registerProvider(new RssNewsProvider('wsj_markets', 'WSJ Markets', 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', 0.95));
    this.registerProvider(new FinnhubNewsProvider());
    this.registerProvider(new AlphaVantageNewsProvider());
    this.registerProvider(new PolygonNewsProvider());
    this.registerProvider(new FMPNewsProvider());
  }

  public registerProvider(provider: NewsProviderPlugin) {
    this.providers.set(provider.id, provider);
    this.stats.set(provider.id, { lastFetchAt: null, lastSuccessAt: null, lastArticleCount: 0, errorCount: 0, lastError: null });
  }

  public getProviders() {
    return Array.from(this.providers.values());
  }

  public getStats(providerId: string): ProviderStats {
    return this.stats.get(providerId) ?? { lastFetchAt: null, lastSuccessAt: null, lastArticleCount: 0, errorCount: 0, lastError: null };
  }

  public async fetchAllLatest() {
    let allArticles = [];
    for (const provider of this.providers.values()) {
      const stat = this.stats.get(provider.id)!;
      if (provider.isConfigured && !provider.isConfigured()) {
        // Not an error - it just has no API key set, so it was never actually fetched.
        continue;
      }
      stat.lastFetchAt = new Date().toISOString();
      try {
        const articles = await provider.fetchLatest();
        stat.lastSuccessAt = stat.lastFetchAt;
        stat.lastArticleCount = articles.length;
        allArticles.push(...articles);
      } catch (err) {
        stat.errorCount += 1;
        stat.lastError = String(err);
        console.error(`[NewsProviderManager] Error fetching from ${provider.name}:`, err);
        eventBus.publish('NEWS_PROVIDER_FAILED', { providerId: provider.id, error: String(err) });
      }
    }
    return allArticles;
  }
}
