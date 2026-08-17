/**
 * Fetch Alpaca historical bars into data/research/{datasetId}.parquet after GREEN quality only.
 * Also flushes parquet for any existing GREEN bars.json caches (SPY/QQQ/AAPL/NVDA/MSFT/AMD).
 * Does nothing without ALPACA keys for remote ingest — local flush still runs when bars.json exist.
 * Never fabricates OHLC. Not a live path.
 *
 * Usage: npx tsx scripts/ingest_research_warehouse.ts
 */
import dotenv from 'dotenv';
dotenv.config();
import { ingestWarehouseDataset, warehouseSymbols, WAREHOUSE_TIMEFRAMES } from '../src/server/research/ingestAlpacaWarehouse';
import { flushAllGreenParquet, listGreenBarsJsonDatasetIds } from '../src/server/research/parquetStore';
import { inspectResearchWarehouse } from '../src/server/research/warehouseInventory';

async function main() {
  // Fail-closed durable write: without this flag, GREEN ingest never materializes parquet.
  process.env.ARGUS_WRITE_RESEARCH_PARQUET = 'true';
  // Clear vitest isolation if someone ran this under a test env by mistake.
  delete process.env.VITEST;
  if (process.env.ARGUS_RESEARCH_DIR?.includes('argus_research_test_')) {
    delete process.env.ARGUS_RESEARCH_DIR;
  }

  const flushed = await flushAllGreenParquet();
  const inventoryAfterFlush = inspectResearchWarehouse();

  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) {
    console.log(JSON.stringify({
      ok: true,
      error: null,
      note: 'NO_ALPACA_KEYS — remote ingest skipped. Local GREEN parquet flush attempted.',
      flushed,
      inventory: inventoryAfterFlush,
      greenBarsJsonIds: listGreenBarsJsonDatasetIds(),
      canPlaceOrders: false,
    }, null, 2));
    process.exit(flushed.some((f) => f.written) || inventoryAfterFlush.greenParquetCount > 0 ? 0 : 1);
  }

  const end = new Date();
  const start = new Date(end.getTime() - 7 * 86400000);
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const out = [];
  for (const symbol of warehouseSymbols().slice(0, 3)) {
    for (const timeframe of WAREHOUSE_TIMEFRAMES) {
      const r = await ingestWarehouseDataset({ symbol, timeframe, startIso, endIso, writeParquet: true });
      out.push({
        symbol,
        timeframe,
        quality: r.quality.quality,
        bars: r.dataset.bars.length,
        written: r.written,
        reason: r.reason,
        provenance: r.dataset.provenance,
      });
    }
  }
  console.log(JSON.stringify({
    ok: true,
    canPlaceOrders: false,
    flushed,
    inventory: inspectResearchWarehouse(),
    datasets: out,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
