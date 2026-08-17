/**
 * Research storage contract. Millions of bars belong in Parquet, not SQLite.
 * Writes are opt-in (ARGUS_WRITE_RESEARCH_PARQUET=true) so tests never touch disk.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CanonicalDataset } from './ohlcvTypes';
import { hashCanonicalDataset } from './datasetHash';
import { runResearchCli } from './VectorBTService';

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

/** True only when the physical .parquet file exists on disk. */
export function parquetBytesExistOnDisk(datasetId: string): boolean {
  const { parquetPath } = parquetTarget(datasetId);
  return existsSync(parquetPath);
}

/** GREEN REAL_MARKET_DATA dataset ids that have bars.json (may still lack parquet). */
export function listGreenBarsJsonDatasetIds(): string[] {
  const dir = researchDataDir();
  if (!existsSync(dir)) return [];
  const ids: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.meta.json')) continue;
    try {
      const meta = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        datasetId?: string;
        qualityStatus?: string;
        provenance?: string;
      };
      const id = meta.datasetId || name.replace(/\.meta\.json$/, '');
      if (meta.qualityStatus !== 'GREEN' || meta.provenance !== 'REAL_MARKET_DATA') continue;
      if (!existsSync(join(dir, `${id}.bars.json`))) continue;
      ids.push(id);
    } catch {
      // skip malformed
    }
  }
  return ids.sort();
}

/**
 * Flush physical parquet via allowlisted Python write_parquet for an existing GREEN bars.json.
 * Updates sidecar parquetBytesWritten only when the file exists after the write.
 */
export async function flushParquetForGreenDataset(datasetId: string): Promise<{
  written: boolean;
  reason: string;
  datasetId: string;
  parquetPath: string;
}> {
  const { parquetPath, sidecarPath } = parquetTarget(datasetId);
  if (process.env.ARGUS_WRITE_RESEARCH_PARQUET !== 'true') {
    return { written: false, reason: 'ARGUS_WRITE_RESEARCH_PARQUET is not true', datasetId, parquetPath };
  }
  if (process.env.VITEST === 'true' && process.env.ARGUS_TEST_ALLOW_VECTORBT !== 'true') {
    return { written: false, reason: 'vitest_skips_python_parquet', datasetId, parquetPath };
  }
  const ds = loadWrittenDataset(datasetId);
  if (!ds) {
    return { written: false, reason: 'bars_json_missing', datasetId, parquetPath };
  }
  if (ds.qualityStatus !== 'GREEN' || ds.provenance !== 'REAL_MARKET_DATA') {
    return { written: false, reason: 'DATA_QUALITY_NOT_GREEN_REAL', datasetId, parquetPath };
  }
  if (!existsSync(sidecarPath)) {
    writeDatasetSidecar(ds, { parquetBytesWritten: false });
  }
  const py = await runResearchCli({
    job: 'write_parquet',
    datasetId,
    quality: 'GREEN',
    bars: ds.bars,
    outDir: researchDataDir(),
  }) as { ok?: boolean; written?: boolean; error?: string; path?: string };
  if (py?.written === true && existsSync(parquetPath)) {
    writeDatasetSidecar(ds, { parquetBytesWritten: true });
    markParquetBytesWritten(datasetId);
    return { written: true, reason: 'parquet_written', datasetId, parquetPath };
  }
  return {
    written: false,
    reason: py?.error || 'parquet_not_written',
    datasetId,
    parquetPath,
  };
}

/** Flush all GREEN bars.json caches that still lack durable parquet. */
export async function flushAllGreenParquet(): Promise<Array<{
  written: boolean;
  reason: string;
  datasetId: string;
  parquetPath: string;
}>> {
  const out = [];
  for (const id of listGreenBarsJsonDatasetIds()) {
    if (parquetBytesExistOnDisk(id)) {
      markParquetBytesWritten(id);
      out.push({
        written: true,
        reason: 'already_on_disk',
        datasetId: id,
        parquetPath: parquetTarget(id).parquetPath,
      });
      continue;
    }
    out.push(await flushParquetForGreenDataset(id));
  }
  return out;
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
