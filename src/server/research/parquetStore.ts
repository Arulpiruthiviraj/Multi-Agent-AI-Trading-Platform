/**
 * Research storage contract. Millions of bars belong in Parquet, not SQLite.
 * Writes are opt-in (ARGUS_WRITE_RESEARCH_PARQUET=true) so tests never touch disk.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CanonicalDataset } from './ohlcvTypes';
import { hashCanonicalDataset } from './datasetHash';

export function researchDataDir(): string {
  return join(process.cwd(), 'data', 'research');
}

export function parquetTarget(datasetId: string): { parquetPath: string; sidecarPath: string } {
  const dir = researchDataDir();
  return {
    parquetPath: join(dir, `${datasetId}.parquet`),
    sidecarPath: join(dir, `${datasetId}.meta.json`),
  };
}

export function writeDatasetSidecar(ds: CanonicalDataset): { written: boolean; reason: string; dataHash: string } {
  const dataHash = hashCanonicalDataset(ds);
  if (process.env.ARGUS_WRITE_RESEARCH_PARQUET !== 'true') {
    return { written: false, reason: 'ARGUS_WRITE_RESEARCH_PARQUET is not true', dataHash };
  }
  const dir = researchDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const { sidecarPath, parquetPath } = parquetTarget(ds.datasetId);
  writeFileSync(sidecarPath, JSON.stringify({
    ...ds,
    bars: undefined,
    barCount: ds.bars.length,
    dataHash,
    parquetPath,
    parquetBytesWritten: false,
    note: 'OHLCV columns belong in Parquet via the Python write_parquet job after DataQuality GREEN. This sidecar is metadata-only. RED/YELLOW must not write parquet.',
  }, null, 2));
  return { written: true, reason: 'sidecar_only', dataHash };
}
