import type { CanonicalDataset, DataProvenance } from './ohlcvTypes';
import { assessDataQuality } from './dataQuality';
import { hashCanonicalDataset } from './datasetHash';
import { parquetTarget, writeDatasetSidecar } from './parquetStore';

export interface RegisteredDataset {
  datasetId: string;
  symbol: string;
  market: string;
  frequency: string;
  source: string;
  startTimestamp: number | null;
  endTimestamp: number | null;
  rowCount: number;
  dataHash: string;
  quality: string;
  adjustmentPolicy: string;
  provenance: DataProvenance;
  parquetPath: string;
  sidecarPath: string;
}

const registry = new Map<string, { meta: RegisteredDataset; dataset: CanonicalDataset }>();

export function registerDataset(ds: CanonicalDataset): RegisteredDataset {
  const provenance: DataProvenance = ds.provenance ?? 'UNKNOWN';
  const quality = assessDataQuality(ds);
  const dataHash = hashCanonicalDataset(ds);
  const ts = ds.bars.map((b) => b.timestamp);
  const { parquetPath, sidecarPath } = parquetTarget(ds.datasetId);
  const meta: RegisteredDataset = {
    datasetId: ds.datasetId,
    symbol: ds.symbol,
    market: ds.market,
    frequency: ds.frequency,
    source: ds.source,
    startTimestamp: ts.length ? Math.min(...ts) : null,
    endTimestamp: ts.length ? Math.max(...ts) : null,
    rowCount: ds.bars.length,
    dataHash,
    quality: quality.quality,
    adjustmentPolicy: ds.adjustmentPolicy,
    provenance,
    parquetPath,
    sidecarPath,
  };
  registry.set(ds.datasetId, { meta, dataset: { ...ds, provenance } });
  writeDatasetSidecar({ ...ds, provenance });
  return meta;
}

export function getRegistered(datasetId: string) {
  return registry.get(datasetId);
}

export function listRegistered(): RegisteredDataset[] {
  return [...registry.values()].map((x) => x.meta);
}
