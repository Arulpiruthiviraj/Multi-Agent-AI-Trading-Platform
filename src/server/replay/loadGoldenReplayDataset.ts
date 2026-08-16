import type { CanonicalDataset, ResearchBar } from '../research/ohlcvTypes';

const NY_OPEN_UTC_HOUR = 14;
const NY_OPEN_UTC_MINUTE = 30;

function nextWeekdayUtc(ms: number): number {
  const d = new Date(ms);
  const day = d.getUTCDay();
  if (day === 6) return ms + 2 * 86_400_000;
  if (day === 0) return ms + 86_400_000;
  return ms;
}

/** Deterministic UNIT_FIXTURE. Not REAL_MARKET_DATA. Not organic paper. */
export function loadGoldenReplayDataset(): CanonicalDataset {
  const bars: ResearchBar[] = [];
  let t = Date.UTC(2024, 0, 2, NY_OPEN_UTC_HOUR, NY_OPEN_UTC_MINUTE, 0);
  let i = 0;
  while (bars.length < 80) {
    t = nextWeekdayUtc(t);
    const day = new Date(t).getUTCDay();
    if (day === 0 || day === 6) {
      t += 86_400_000;
      continue;
    }
    const close = 100 + i * 0.4 - (i > 55 ? (i - 55) * 1.1 : 0);
    const open = close - 0.15;
    const high = close + 0.4;
    const low = open - 0.2;
    bars.push({
      timestamp: t,
      open: Number(open.toFixed(4)),
      high: Number(high.toFixed(4)),
      low: Number(low.toFixed(4)),
      close: Number(close.toFixed(4)),
      volume: 1_000_000 + i * 1000,
    });
    t += 86_400_000;
    i += 1;
  }
  return {
    schemaVersion: 1,
    datasetId: 'golden_replay_AAPL_1Day',
    symbol: 'AAPL',
    timezone: 'America/New_York',
    frequency: '1Day',
    adjustmentPolicy: 'SPLIT_ADJUSTED',
    missingBarPolicy: 'count_not_fill',
    duplicatePolicy: 'reject',
    source: 'golden_replay_fixture',
    sourceVersion: 'v1',
    market: 'US',
    startTimestamp: bars[0].timestamp,
    endTimestamp: bars[bars.length - 1].timestamp,
    qualityStatus: 'YELLOW',
    provenance: 'UNIT_FIXTURE',
    bars,
  };
}

export interface HistoricalNewsItem {
  newsId: string;
  publishedAt: number;
  source: string;
  headline: string;
  summary: string;
  url: string;
  symbols: string[];
  sentiment: number | null;
  sourceTimestamp: number;
}

export function loadGoldenReplayNews(): HistoricalNewsItem[] {
  const ds = loadGoldenReplayDataset();
  const t0 = ds.bars[10].timestamp;
  return [
    {
      newsId: 'golden-news-1',
      publishedAt: t0,
      source: 'UNIT_FIXTURE',
      headline: 'Fixture catalyst at bar 10',
      summary: 'Point-in-time only. Not a live feed.',
      url: 'https://invalid.local/golden-news-1',
      symbols: ['AAPL'],
      sentiment: null,
      sourceTimestamp: t0,
    },
    {
      newsId: 'golden-news-future',
      publishedAt: ds.bars[70].timestamp,
      source: 'UNIT_FIXTURE',
      headline: 'Future fixture article — must not leak before bar 70',
      summary: 'Look-ahead test row',
      url: 'https://invalid.local/golden-news-future',
      symbols: ['AAPL'],
      sentiment: null,
      sourceTimestamp: ds.bars[70].timestamp,
    },
  ];
}
