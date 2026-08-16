/**
 * Historical data providers. Unavailable providers stay UNAVAILABLE — never fake bars.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WAREHOUSE_TIMEFRAMES, ingestWarehouseDataset } from '../research/ingestAlpacaWarehouse';
import type { CanonicalDataset } from '../research/ohlcvTypes';
import { loadGoldenReplayDataset } from './loadGoldenReplayDataset';
import { replaySafety } from './replaySafety';

function mapFrequencyToAlpaca(frequency: string): string | null {
  const f = frequency.toLowerCase();
  const map: Record<string, string> = {
    '1m': '1Min',
    '1min': '1Min',
    '5m': '5Min',
    '5min': '5Min',
    '15m': '15Min',
    '15min': '15Min',
    '30m': '15Min', // nearest supported warehouse TF; caller still sees requested freq in meta if rejected below
    '1h': '1Hour',
    '1hour': '1Hour',
    '60min': '1Hour',
    '1d': '1Day',
    '1day': '1Day',
    day: '1Day',
  };
  const tf = map[f] ?? (WAREHOUSE_TIMEFRAMES as readonly string[]).find((x) => x.toLowerCase() === f) ?? null;
  if (f === '30m' || f === '30min') return null; // honest: Alpaca warehouse list has no 30Min
  return tf;
}

export type ProviderAvailability = 'AVAILABLE' | 'DATA_PROVIDER_UNAVAILABLE' | 'UNAUTHENTICATED';

export interface HistoricalProviderDescriptor {
  id: string;
  name: string;
  availability: ProviderAvailability;
  supportedMarkets: string[];
  supportedFrequencies: string[];
  historicalDepth: string;
  dataQuality: string;
  rateLimits: string;
  authenticationStatus: string;
  note: string;
}

export interface HistoricalDataProvider {
  id: string;
  describe(): HistoricalProviderDescriptor;
  fetch(opts: { symbol: string; startMs: number; endMs: number; frequency: string }): Promise<CanonicalDataset | { error: string; code: 'DATA_UNAVAILABLE' | 'DATA_PROVIDER_UNAVAILABLE' }>;
}

function alpacaKeysPresent(): boolean {
  return !!(process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY);
}

const alpacaProvider: HistoricalDataProvider = {
  id: 'alpaca',
  describe() {
    const auth = alpacaKeysPresent();
    return {
      id: 'alpaca',
      name: 'Alpaca historical bars',
      availability: auth ? 'AVAILABLE' : 'UNAUTHENTICATED',
      supportedMarkets: ['US'],
      supportedFrequencies: replaySafety.supportedFrequencies,
      historicalDepth: 'Provider-limited. 1Day ingest uses researchSafety.ingestDailyLookbackDays when used via warehouse.',
      dataQuality: 'Assessed after download. Incomplete fetch is not GREEN.',
      rateLimits: 'Alpaca REST pagination; ingestMaxPages in researchSafety.json',
      authenticationStatus: auth ? 'keys_present' : 'ALPACA_API_KEY/ALPACA_SECRET_KEY missing',
      note: 'IEX feed from researchSafety.alpacaBarsFeed. Not a live broker call from replay.',
    };
  },
  async fetch(opts) {
    // Unsupported frequencies fail closed before auth — honest gap, not "keys missing".
    const timeframe = mapFrequencyToAlpaca(opts.frequency);
    if (!timeframe) {
      return {
        error: `DATA_UNAVAILABLE: Alpaca warehouse ingest supports ${WAREHOUSE_TIMEFRAMES.join(', ')} (plus 1m/5m/15m/1h/1Day aliases). Requested ${opts.frequency}.`,
        code: 'DATA_UNAVAILABLE',
      };
    }
    if (!alpacaKeysPresent()) {
      return { error: 'DATA_PROVIDER_UNAVAILABLE: Alpaca keys missing', code: 'DATA_PROVIDER_UNAVAILABLE' };
    }
    const startIso = new Date(opts.startMs).toISOString();
    const endIso = new Date(opts.endMs).toISOString();
    const ingested = await ingestWarehouseDataset({
      symbol: opts.symbol,
      timeframe,
      startIso,
      endIso,
      // Persist GREEN warehouse when operator/env opts in — never silently write in Vitest.
      writeParquet: process.env.ARGUS_WRITE_RESEARCH_PARQUET === 'true',
    });
    if (ingested.fetchStatus !== 'OK' || !ingested.dataset.bars.length) {
      return { error: `DATA_UNAVAILABLE: Alpaca ingest ${ingested.fetchStatus} ${ingested.errorDetail || ingested.reason}`, code: 'DATA_UNAVAILABLE' };
    }
    ingested.dataset.bars = ingested.dataset.bars.filter((b) => b.timestamp >= opts.startMs && b.timestamp <= opts.endMs);
    return ingested.dataset;
  },
};

function unavailable(id: string, name: string): HistoricalDataProvider {
  return {
    id,
    describe: () => ({
      id,
      name,
      availability: 'DATA_PROVIDER_UNAVAILABLE',
      supportedMarkets: [],
      supportedFrequencies: [],
      historicalDepth: 'UNAVAILABLE',
      dataQuality: 'UNAVAILABLE',
      rateLimits: 'UNAVAILABLE',
      authenticationStatus: 'not_configured',
      note: `${name} adapter is not implemented. DATA_PROVIDER_UNAVAILABLE — bars are not invented.`,
    }),
    async fetch() {
      return { error: `DATA_PROVIDER_UNAVAILABLE: ${name}`, code: 'DATA_PROVIDER_UNAVAILABLE' };
    },
  };
}

const fixtureProvider: HistoricalDataProvider = {
  id: 'golden_replay',
  describe() {
    return {
      id: 'golden_replay',
      name: 'Golden replay UNIT_FIXTURE',
      availability: 'AVAILABLE',
      supportedMarkets: ['US'],
      supportedFrequencies: ['1Day'],
      historicalDepth: 'Fixed fixture length',
      dataQuality: 'UNIT_FIXTURE — not REAL_MARKET_DATA',
      rateLimits: 'none',
      authenticationStatus: 'n/a',
      note: 'Deterministic bars for look-ahead and accounting tests. Not promotion evidence.',
    };
  },
  async fetch() {
    return loadGoldenReplayDataset();
  },
};

const registry: HistoricalDataProvider[] = [
  alpacaProvider,
  fixtureProvider,
  unavailable('polygon', 'Polygon/Massive'),
  unavailable('twelvedata', 'Twelve Data'),
  unavailable('alphavantage', 'Alpha Vantage'),
  unavailable('ibkr', 'Interactive Brokers historical'),
];

export function listHistoricalProviders(): HistoricalProviderDescriptor[] {
  return registry.map((p) => p.describe());
}

export function getHistoricalProvider(id: string): HistoricalDataProvider | undefined {
  return registry.find((p) => p.id === id);
}

export function loadBarsJsonIfPresent(path: string): CanonicalDataset | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CanonicalDataset;
  } catch {
    return null;
  }
}

export function warehouseBarsPath(dir: string, datasetId: string): string {
  return join(dir, `${datasetId}.bars.json`);
}
