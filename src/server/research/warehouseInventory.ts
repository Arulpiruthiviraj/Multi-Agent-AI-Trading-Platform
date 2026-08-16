/**
 * Inspect on-disk research warehouse. Never invents GREEN parquet.
 * Sidecar GREEN without a parquet file is not a warehouse.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { researchDataDir } from './parquetStore';

export interface WarehouseInventory {
  dir: string;
  sidecarCount: number;
  greenParquetCount: number;
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
      greenRealMarketData: false,
      note: 'Research warehouse directory is absent. Empty is not GREEN REAL_MARKET_DATA.',
    };
  }
  const names = readdirSync(dir).filter((n) => n.endsWith('.meta.json'));
  let greenParquetCount = 0;
  for (const name of names) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        qualityStatus?: string;
        provenance?: string;
        parquetPath?: string;
        datasetId?: string;
        barCount?: number;
      };
      const parquetPath = typeof raw.parquetPath === 'string' ? raw.parquetPath : join(dir, name.replace(/\.meta\.json$/, '.parquet'));
      const barsJson = join(dir, name.replace(/\.meta\.json$/, '.bars.json'));
      const greenMeta = raw.qualityStatus === 'GREEN' && raw.provenance === 'REAL_MARKET_DATA';
      const green = greenMeta && (existsSync(parquetPath) || existsSync(barsJson));
      if (green) greenParquetCount += 1;
    } catch {
      // Malformed sidecar is not GREEN.
    }
  }
  return {
    dir,
    sidecarCount: names.length,
    greenParquetCount,
    greenRealMarketData: greenParquetCount > 0,
    note: greenParquetCount > 0
      ? `${greenParquetCount} GREEN REAL_MARKET_DATA parquet file(s). Presence is not OOS/WFO/paper validation.`
      : 'No GREEN REAL_MARKET_DATA parquet or bars.json on disk. Sidecars without bars do not count.',
  };
}
