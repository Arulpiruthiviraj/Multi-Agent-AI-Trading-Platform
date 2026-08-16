/**
 * Research storage contract. Millions of bars belong in Parquet, not SQLite.
 * Writes are opt-in (ARGUS_WRITE_RESEARCH_PARQUET=true) so tests never touch disk.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CanonicalDataset } from './ohlcvTypes';
import { hashCanonicalDataset } from './datasetHash';

export function researchDataDir(): string {
  if (process.env.ARGUS_RESEARCH_DIR) return process.env.ARGUS_RESEARCH_DIR;
  return join(process.cwd(), 'data', 'research');
}

export function parquetTarget(datasetId: string): { parquetPath: string; sidecarPath: string } {
  const dir = researchDataDir();
  return {
    parquetPath: join(dir, `${datasetId}.parquet`),
    sidecarPath: join(dir, `${datasetId}.meta.json`),
  };
}

export function writeDatasetSidecar(ds: CanonicalDataset, opts?: { parquetBytesWritten?: boolean }): { written: boolean; reason: string; dataHash: string } {
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
    parquetBytesWritten: opts?.parquetBytesWritten === true,
    note: 'OHLCV columns belong in Parquet via the Python write_parquet job after DataQuality GREEN. This sidecar is metadata-only. RED/YELLOW must not write parquet.',
  }, null, 2));
  return { written: true, reason: opts?.parquetBytesWritten ? 'sidecar_with_parquet_flag' : 'sidecar_only', dataHash };
}

/** After Python write_parquet succeeds, flip sidecar parquetBytesWritten without inventing bars. */
export function markParquetBytesWritten(datasetId: string): boolean {
  if (process.env.ARGUS_WRITE_RESEARCH_PARQUET !== 'true') return false;
  const { sidecarPath, parquetPath } = parquetTarget(datasetId);
  if (!existsSync(sidecarPath)) return false;
  try {
    const meta = JSON.parse(readFileSync(sidecarPath, 'utf8')) as Record<string, unknown>;
    meta.parquetBytesWritten = existsSync(parquetPath);
    meta.parquetPath = parquetPath;
    writeFileSync(sidecarPath, JSON.stringify(meta, null, 2));
    return meta.parquetBytesWritten === true;
  } catch {
    return false;
  }
}

export function writeDatasetBars(ds: CanonicalDataset): { written: boolean; reason: string } {
  if (process.env.ARGUS_WRITE_RESEARCH_PARQUET !== 'true') {
    return { written: false, reason: 'ARGUS_WRITE_RESEARCH_PARQUET is not true' };
  }
  if (ds.qualityStatus !== 'GREEN' || ds.provenance !== 'REAL_MARKET_DATA') {
    return { written: false, reason: 'bars_json_only_after_green_real_market_data' };
  }
  const dir = researchDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const barsPath = join(dir, `${ds.datasetId}.bars.json`);
  writeFileSync(barsPath, JSON.stringify(ds));
  return { written: true, reason: 'bars_json' };
}

export function loadWrittenDataset(datasetId: string): CanonicalDataset | null {
  const barsPath = join(researchDataDir(), `${datasetId}.bars.json`);
  if (!existsSync(barsPath)) return null;
  try {
    const ds = JSON.parse(readFileSync(barsPath, 'utf8')) as CanonicalDataset;
    if (!Array.isArray(ds.bars) || ds.bars.length === 0) return null;
    return ds;
  } catch {
    return null;
  }
}
