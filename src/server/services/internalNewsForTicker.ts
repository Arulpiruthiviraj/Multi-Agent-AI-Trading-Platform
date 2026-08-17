/**
 * Honest NewsEngine/NewsMemory fallback for GET /api/v1/alpaca/news.
 * Never fabricates headlines. Empty book → available:false, not HTTP 500.
 */
import { desc, sql } from 'drizzle-orm';
import { db } from '../db';
import * as schema from '../db/schema';
import { NewsMemoryEngine } from '../news/NewsMemoryEngine';

export type TickerNewsItem = {
  id: string;
  headline: string;
  summary: string;
  author: string;
  created_at: string;
  url?: string | null;
  symbols: string[];
  source: string;
};

export type TickerNewsPayload = {
  available: boolean;
  news: TickerNewsItem[];
  source: 'NewsEngine';
  reason?: string;
};

export function parseStoredSymbols(raw: unknown, fallback: string): string[] {
  if (Array.isArray(raw)) {
    return raw.map(String).filter(Boolean);
  }
  if (typeof raw !== 'string' || !raw.trim()) {
    return fallback ? [fallback] : [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    /* stored as a plain ticker, not JSON */
  }
  return [raw];
}

export function mapInternalNewsRows(rows: any[], symbol: string): TickerNewsItem[] {
  return rows.map((item) => ({
    id: String(item.id ?? ''),
    headline: item.title || item.headline || '',
    summary: item.summary || item.content || '',
    author: item.author || item.source || 'NewsEngine',
    created_at: item.createdAt || item.publishedAt || item.created_at || '',
    url: item.url ?? null,
    symbols: parseStoredSymbols(item.symbols, symbol),
    source: item.source || 'NewsEngine',
  }));
}

export async function loadInternalNewsForTicker(symbol: string, limit = 5): Promise<TickerNewsPayload> {
  const ticker = (symbol || '').trim();
  try {
    const engine = new NewsMemoryEngine();
    const clusters = await engine.getRecentEventsForSymbol(ticker, limit);
    if (clusters.length > 0) {
      return { available: true, news: mapInternalNewsRows(clusters, ticker), source: 'NewsEngine' };
    }

    const articles = ticker
      ? await db.select().from(schema.newsArticles)
          .where(sql`${schema.newsArticles.symbols} LIKE ${'%' + ticker + '%'}`)
          .orderBy(desc(schema.newsArticles.publishedAt))
          .limit(limit)
      : await db.select().from(schema.newsArticles)
          .orderBy(desc(schema.newsArticles.publishedAt))
          .limit(limit);

    if (articles.length > 0) {
      return { available: true, news: mapInternalNewsRows(articles, ticker), source: 'NewsEngine' };
    }

    return {
      available: false,
      news: [],
      source: 'NewsEngine',
      reason: ticker
        ? `NewsEngine has no stored items for ${ticker}.`
        : 'NewsEngine has no stored items.',
    };
  } catch (e: any) {
    return {
      available: false,
      news: [],
      source: 'NewsEngine',
      reason: `NewsEngine fallback failed: ${e?.message || e}`,
    };
  }
}
