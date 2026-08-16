/**
 * Fetch Alpaca historical bars into data/research/{datasetId}.parquet after GREEN quality only.
 * Does nothing without ALPACA_API_KEY. Never fabricates OHLC. Not a live path.
 *
 * Usage: npx tsx scripts/ingest_research_warehouse.ts
 */
import { ingestWarehouseDataset, warehouseSymbols, WAREHOUSE_TIMEFRAMES } from '../src/server/research/ingestAlpacaWarehouse';

async function main() {
  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) {
    console.log(JSON.stringify({ ok: false, error: 'NO_ALPACA_KEYS', written: false, note: 'No bars fabricated.' }));
    process.exit(0);
  }
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 86400000);
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const out = [];
  for (const symbol of warehouseSymbols().slice(0, 3)) {
    for (const timeframe of WAREHOUSE_TIMEFRAMES) {
      const r = await ingestWarehouseDataset({ symbol, timeframe, startIso, endIso });
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
  console.log(JSON.stringify({ ok: true, canPlaceOrders: false, datasets: out }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
