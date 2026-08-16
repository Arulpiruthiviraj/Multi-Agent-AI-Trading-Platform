import { createHash } from 'node:crypto';
import type { CanonicalDataset } from './ohlcvTypes';

/** Reproducible hash: metadata + bars in timestamp order. Does not include downloadTimestamp. */
export function hashCanonicalDataset(ds: CanonicalDataset): string {
  const bars = [...ds.bars].sort((a, b) => a.timestamp - b.timestamp);
  const payload = JSON.stringify({
    datasetId: ds.datasetId,
    symbol: ds.symbol,
    timezone: ds.timezone,
    frequency: ds.frequency,
    adjustmentPolicy: ds.adjustmentPolicy,
    provenance: ds.provenance ?? 'UNKNOWN',
    source: ds.source,
    sourceVersion: ds.sourceVersion,
    market: ds.market,
    bars,
  });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}
