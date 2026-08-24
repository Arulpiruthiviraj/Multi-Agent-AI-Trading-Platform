/**
 * Point-in-time news. Today's News API is never treated as historical.
 */
import type { HistoricalNewsItem } from './loadGoldenReplayDataset';
import { loadGoldenReplayNews } from './loadGoldenReplayDataset';
import type { InformationCutoff } from './InformationCutoff';
import { db } from '../db';
import * as schema from '../db/schema';
import { and, gte, lte } from 'drizzle-orm';

export interface HistoricalNewsProvider {
  id: string;
  available: boolean;
  status: 'AVAILABLE' | 'HISTORICAL_NEWS_UNAVAILABLE';
  note: string;
  all(): HistoricalNewsItem[];
}

export function goldenReplayNewsProvider(): HistoricalNewsProvider {
  const rows = loadGoldenReplayNews();
  return {
    id: 'golden_replay_news',
    available: true,
    status: 'AVAILABLE',
    note: 'UNIT_FIXTURE news only. Not a live News API. CATALYST_ONLY — not an independent BUY voter.',
    all: () => rows,
  };
}

export function unavailableHistoricalNewsProvider(): HistoricalNewsProvider {
  return {
    id: 'none',
    available: false,
    status: 'HISTORICAL_NEWS_UNAVAILABLE',
    note: 'Do not substitute today\'s news. NewsAgent may operate CATALYST_ONLY with empty PIT corpus.',
    all: () => [],
  };
}

/**
 * Real historical news archive provider (PIT agent ledger system). Reads
 * `historical_news_archive` for the given symbols/window (see schema.ts's own header comment on
 * epoch-ms INTEGER date columns) - unlike goldenReplayNewsProvider's fixture, this is real data
 * when the archive has been backfilled for that window, and correctly falls back to the
 * unavailable provider (never a fabricated headline) when it hasn't. This is what lets NewsAgent
 * upgrade from CATALYST_ONLY-fixture-only to a real PIT voter in FullArgusReplayEngine.ts, for any
 * real historical window the archive actually covers.
 */
export async function loadHistoricalNewsArchiveProvider(symbols: string[], startMs: number, endMs: number): Promise<HistoricalNewsProvider> {
  if (symbols.length === 0) return unavailableHistoricalNewsProvider();
  const rows = await db.select().from(schema.historicalNewsArchive).where(
    and(gte(schema.historicalNewsArchive.publishedAtMs, startMs), lte(schema.historicalNewsArchive.publishedAtMs, endMs)),
  );
  const scoped = rows.filter((r) => symbols.includes(r.symbol));
  if (scoped.length === 0) return unavailableHistoricalNewsProvider();
  const items: HistoricalNewsItem[] = scoped.map((r) => ({
    newsId: r.id,
    publishedAt: r.publishedAtMs,
    source: r.source || 'historical_news_archive',
    headline: r.headline,
    summary: r.summary || '',
    url: `historical-news-archive://${r.id}`,
    symbols: [r.symbol],
    sentiment: r.sentimentScore,
    sourceTimestamp: r.publishedAtMs,
  }));
  return {
    id: 'historical_news_archive',
    available: true,
    status: 'AVAILABLE',
    note: `${items.length} real historical news article(s) loaded across ${symbols.length} symbol(s). Real PIT NewsAgent voter, not the golden_replay fixture.`,
    all: () => items,
  };
}

export function newsVisibleAt(provider: HistoricalNewsProvider, cutoff: InformationCutoff, symbol?: string): HistoricalNewsItem[] {
  const t = cutoff.now();
  return provider.all().filter((n) => {
    if (n.publishedAt > t) return false;
    cutoff.assertNotFuture(n.publishedAt, `news ${n.newsId}`);
    if (symbol && !n.symbols.includes(symbol)) return false;
    return true;
  });
}
