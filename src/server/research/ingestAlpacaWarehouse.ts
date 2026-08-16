/**
 * Production research warehouse ingest. Fetches Alpaca historical REST only when keys exist.
 * Never fabricates bars. Grades RAW first, then cleaned. Parquet only after GREEN.
 */
import { assessDataQuality } from './dataQuality';
import type { CanonicalDataset, ResearchBar } from './ohlcvTypes';
import { runResearchCli } from './VectorBTService';
import { writeDatasetSidecar } from './parquetStore';
import { loadRepoConfigJson } from '../config/loadRepoConfigJson';
import { researchSafety } from '../config/researchSafety';

export const WAREHOUSE_TIMEFRAMES = ['1Min', '5Min', '15Min', '1Hour', '1Day'] as const;

export function warehouseSymbols(): string[] {
  try {
    const cfg = loadRepoConfigJson<{ markets?: { US?: { benchmarks?: string[] } } }>('markets.json');
    const b = cfg.markets?.US?.benchmarks;
    return Array.isArray(b) ? b.filter((s) => typeof s === 'string' && s.length > 0) : ['SPY', 'QQQ', 'IWM'];
  } catch {
    return ['SPY', 'QQQ', 'IWM'];
  }
}

export function cleanOhlcv(bars: ResearchBar[]): { cleaned: ResearchBar[]; droppedBarCount: number } {
  const byTs = new Map<number, ResearchBar>();
  let dropped = 0;
  for (const b of bars) {
    if (![b.open, b.high, b.low, b.close, b.volume, b.timestamp].every((x) => Number.isFinite(x))) {
      dropped += 1;
      continue;
    }
    if (b.open <= 0 || b.high <= 0 || b.low <= 0 || b.close <= 0) {
      dropped += 1;
      continue;
    }
    if (!(b.high >= b.low)) {
      dropped += 1;
      continue;
    }
    if (!(b.open >= b.low && b.open <= b.high)) {
      dropped += 1;
      continue;
    }
    if (!(b.close >= b.low && b.close <= b.high)) {
      dropped += 1;
      continue;
    }
    if (b.volume < 0) {
      dropped += 1;
      continue;
    }
    byTs.set(b.timestamp, b);
  }
  return { cleaned: [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp), droppedBarCount: bars.length - byTs.size };
}

function alpacaTimeframe(tf: string): string {
  if (tf === '1Hour') return '1Hour';
  if (tf === '1Day') return '1Day';
  return tf;
}

export async function fetchAlpacaBars(symbol: string, timeframe: string, startIso: string, endIso: string): Promise<ResearchBar[]> {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!key || !secret) return [];
  const out: ResearchBar[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const url = new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars`);
    url.searchParams.set('timeframe', alpacaTimeframe(timeframe));
    url.searchParams.set('start', startIso);
    url.searchParams.set('end', endIso);
    url.searchParams.set('limit', '10000');
    url.searchParams.set('adjustment', 'raw');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const res = await fetch(url, { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret } });
    if (!res.ok) return out;
    const body = await res.json() as { bars?: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>; next_page_token?: string };
    const rows = Array.isArray(body.bars) ? body.bars : [];
    for (const r of rows) {
      out.push({
        timestamp: new Date(r.t).getTime(),
        open: r.o,
        high: r.h,
        low: r.l,
        close: r.c,
        volume: r.v,
      });
    }
    pageToken = body.next_page_token;
    pages += 1;
  } while (pageToken && pages < researchSafety.ingestMaxPages);
  return out;
}

export async function ingestWarehouseDataset(opts: {
  symbol: string;
  timeframe: string;
  startIso: string;
  endIso: string;
  writeParquet?: boolean;
}): Promise<{
  dataset: CanonicalDataset;
  rawQuality: ReturnType<typeof assessDataQuality>;
  quality: ReturnType<typeof assessDataQuality>;
  written: boolean;
  reason: string;
  droppedBarCount: number;
}> {
  const raw = await fetchAlpacaBars(opts.symbol, opts.timeframe, opts.startIso, opts.endIso);
  const rawDataset: CanonicalDataset = {
    schemaVersion: 1,
    datasetId: `${opts.symbol}_${opts.timeframe}_${opts.startIso.slice(0, 10)}_raw`,
    symbol: opts.symbol,
    timezone: 'America/New_York',
    frequency: opts.timeframe,
    adjustmentPolicy: 'raw',
    missingBarPolicy: 'drop_invalid',
    duplicatePolicy: 'keep_last',
    source: 'alpaca_historical_rest',
    sourceVersion: 'v2',
    market: 'US',
    bars: raw,
    provenance: raw.length ? 'REAL_MARKET_DATA' : 'UNKNOWN',
  };
  const rawQuality = assessDataQuality(rawDataset);
  const { cleaned, droppedBarCount } = cleanOhlcv(raw);
  const dataset: CanonicalDataset = {
    ...rawDataset,
    datasetId: `${opts.symbol}_${opts.timeframe}_${opts.startIso.slice(0, 10)}`,
    bars: cleaned,
    provenance: cleaned.length ? 'REAL_MARKET_DATA' : 'UNKNOWN',
  };
  const quality = assessDataQuality(dataset, { droppedBarCount });
  dataset.qualityStatus = quality.quality;
  writeDatasetSidecar(dataset);
  if (rawQuality.quality === 'RED' || quality.quality !== 'GREEN') {
    return { dataset, rawQuality, quality, written: false, reason: 'DATA_QUALITY_FAILED', droppedBarCount };
  }
  if (opts.writeParquet === false) {
    return { dataset, rawQuality, quality, written: false, reason: 'write_skipped', droppedBarCount };
  }
  if (process.env.VITEST === 'true' && process.env.ARGUS_TEST_ALLOW_VECTORBT !== 'true') {
    return { dataset, rawQuality, quality, written: false, reason: 'vitest_skips_python_parquet', droppedBarCount };
  }
  const py = await runResearchCli({
    job: 'write_parquet',
    datasetId: dataset.datasetId,
    quality: quality.quality,
    bars: cleaned,
  }) as { ok?: boolean; written?: boolean; error?: string };
  return {
    dataset,
    rawQuality,
    quality,
    written: py?.written === true,
    reason: py?.written ? 'parquet_written' : (py?.error || 'parquet_not_written'),
    droppedBarCount,
  };
}
