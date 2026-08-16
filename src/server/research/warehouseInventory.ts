/**
 * Inspect on-disk research warehouse. Never invents GREEN parquet.
 * Sidecar GREEN without a parquet file is not a parquet warehouse.
 * bars.json alone is research cache, not durable parquet inventory.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { researchDataDir } from './parquetStore';

export interface WarehouseInventory {
  dir: string;
  sidecarCount: number;
  /** GREEN REAL_MARKET_DATA with an on-disk .parquet file only. */
  greenParquetCount: number;
  /** GREEN REAL_MARKET_DATA with .bars.json but no parquet (not durable warehouse). */
  greenBarsJsonOnlyCount: number;
  greenRealMarketData: boolean;
  note: string;
}

export function inspectResearchWarehouse(): WarehouseInventory {
  const dir = researchDataDir();
  if (!existsSync(dir)) {
    return {
      dir,
      sidecarCount: 0,
      greenParquetCount: 0,
      greenBarsJsonOnlyCount: 0,
      greenRealMarketData: false,
      note: 'Research warehouse directory is absent. Empty is not GREEN REAL_MARKET_DATA.',
    };
  }
  const names = readdirSync(dir).filter((n) => n.endsWith('.meta.json'));
  let greenParquetCount = 0;
  let greenBarsJsonOnlyCount = 0;
  for (const name of names) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        qualityStatus?: string;
        provenance?: string;
        parquetPath?: string;
        parquetBytesWritten?: boolean;
        datasetId?: string;
        barCount?: number;
      };
      const parquetPath = typeof raw.parquetPath === 'string' ? raw.parquetPath : join(dir, name.replace(/\.meta\.json$/, '.parquet'));
      const barsJson = join(dir, name.replace(/\.meta\.json$/, '.bars.json'));
      const greenMeta = raw.qualityStatus === 'GREEN' && raw.provenance === 'REAL_MARKET_DATA';
      if (!greenMeta) continue;
      const parquetExists = existsSync(parquetPath);
      if (parquetExists && raw.parquetBytesWritten !== false) {
        greenParquetCount += 1;
      } else if (existsSync(barsJson)) {
        greenBarsJsonOnlyCount += 1;
      }
    } catch {
      // Malformed sidecar is not GREEN.
    }
  }
  const greenRealMarketData = greenParquetCount > 0;
  let note: string;
  if (greenParquetCount > 0) {
    note = `${greenParquetCount} GREEN REAL_MARKET_DATA parquet file(s). Presence is not OOS/WFO/paper validation.`;
    if (greenBarsJsonOnlyCount > 0) {
      note += ` ${greenBarsJsonOnlyCount} additional GREEN sidecar(s) have bars.json only (not parquet warehouse).`;
    }
  } else if (greenBarsJsonOnlyCount > 0) {
    note = `${greenBarsJsonOnlyCount} GREEN REAL_MARKET_DATA bars.json cache(s) on disk, but 0 parquet files. Run ingest with ARGUS_WRITE_RESEARCH_PARQUET=true. Not OOS/WFO/paper validation.`;
  } else {
    note = 'No GREEN REAL_MARKET_DATA parquet on disk. Sidecars without parquet do not count as warehouse.';
  }
  return {
    dir,
    sidecarCount: names.length,
    greenParquetCount,
    greenBarsJsonOnlyCount,
    greenRealMarketData,
    note,
  };
}
