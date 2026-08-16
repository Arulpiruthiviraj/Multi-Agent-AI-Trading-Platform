/**
 * Point-in-time news. Today's News API is never treated as historical.
 */
import type { HistoricalNewsItem } from './loadGoldenReplayDataset';
import { loadGoldenReplayNews } from './loadGoldenReplayDataset';
import type { InformationCutoff } from './InformationCutoff';

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

export function newsVisibleAt(provider: HistoricalNewsProvider, cutoff: InformationCutoff, symbol?: string): HistoricalNewsItem[] {
  const t = cutoff.now();
  return provider.all().filter((n) => {
    if (n.publishedAt > t) return false;
    cutoff.assertNotFuture(n.publishedAt, `news ${n.newsId}`);
    if (symbol && !n.symbols.includes(symbol)) return false;
    return true;
  });
}
