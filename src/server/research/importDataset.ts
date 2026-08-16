import type { CanonicalDataset, DataProvenance, ResearchBar } from './ohlcvTypes';
import { registerDataset } from './datasetRegistry';

const FORBIDDEN = ['code', 'python', 'eval', 'exec', 'broker', 'placeOrder', 'submitOrder'];

export function assertNoArbitraryCode(body: Record<string, unknown>): void {
  for (const k of Object.keys(body)) {
    if (FORBIDDEN.includes(k)) throw new Error('Arbitrary Python/broker execution is not allowed');
  }
}

function parseCsv(csv: string): ResearchBar[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const bars: ResearchBar[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(',');
    bars.push({
      timestamp: Number(cols[idx('timestamp')]),
      open: Number(cols[idx('open')]),
      high: Number(cols[idx('high')]),
      low: Number(cols[idx('low')]),
      close: Number(cols[idx('close')]),
      volume: Number(cols[idx('volume')]),
    });
  }
  return bars;
}

export function importResearchDataset(input: {
  datasetId: string;
  symbol: string;
  market?: string;
  timezone?: string;
  frequency?: string;
  source?: string;
  sourceVersion?: string;
  adjustmentPolicy?: string;
  provenance: DataProvenance;
  csv?: string;
  bars?: ResearchBar[];
}): ReturnType<typeof registerDataset> {
  const bars = input.bars ?? (input.csv ? parseCsv(input.csv) : []);
  const ds: CanonicalDataset = {
    schemaVersion: 1,
    datasetId: input.datasetId,
    symbol: input.symbol,
    market: input.market ?? 'US',
    timezone: input.timezone ?? 'America/New_York',
    frequency: input.frequency ?? '1Day',
    source: input.source ?? 'import',
    sourceVersion: input.sourceVersion ?? 'phase18',
    adjustmentPolicy: input.adjustmentPolicy ?? 'RAW',
    missingBarPolicy: 'keep',
    duplicatePolicy: 'reject',
    bars,
    provenance: input.provenance,
  };
  return registerDataset(ds);
}

export function isPromotableProvenance(p: DataProvenance): boolean {
  return p === 'REAL_MARKET_DATA';
}
