/**
 * Fetch Alpaca historical bars into data/research/{datasetId}.parquet after GREEN quality only.
 * Also flushes parquet for any existing GREEN bars.json caches.
 * Never fabricates OHLC. Not a live path.
 *
 * Usage:
 *   npx tsx scripts/ingest_research_warehouse.ts
 *   npx tsx scripts/ingest_research_warehouse.ts --timeframe 1Day --lookback-days 2520
 *   npx tsx scripts/ingest_research_warehouse.ts --years 10 --symbols SPY,QQQ,IWM,AAPL,MSFT,NVDA,AMD
 *   npx tsx scripts/ingest_research_warehouse.ts --timeframe 5Min --lookback-days 60 --symbols SPY,QQQ,IWM
 */
import dotenv from 'dotenv';
dotenv.config();
import { ingestWarehouseDataset, warehouseSymbols } from '../src/server/research/ingestAlpacaWarehouse';
import { flushAllGreenParquet, listGreenBarsJsonDatasetIds } from '../src/server/research/parquetStore';
import { inspectResearchWarehouse } from '../src/server/research/warehouseInventory';
import { researchSafety } from '../src/server/config/researchSafety';

export function parseIngestArgs(argv: string[]): {
  timeframe: string;
  lookbackDays: number;
  symbols: string[];
  years: number | null;
} {
  let timeframe = '1Day';
  let lookbackDays: number | null = null;
  let years: number | null = null;
  let symbols = [...researchSafety.ingestDefaultSymbols];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--timeframe' && argv[i + 1]) {
      timeframe = String(argv[++i]);
    } else if (a.startsWith('--timeframe=')) {
      timeframe = a.slice('--timeframe='.length);
    } else if (a === '--lookback-days' && argv[i + 1]) {
      lookbackDays = Number(argv[++i]);
    } else if (a.startsWith('--lookback-days=')) {
      lookbackDays = Number(a.slice('--lookback-days='.length));
    } else if (a === '--years' && argv[i + 1]) {
      years = Number(argv[++i]);
    } else if (a.startsWith('--years=')) {
      years = Number(a.slice('--years='.length));
    } else if (a === '--symbols' && argv[i + 1]) {
      symbols = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a.startsWith('--symbols=')) {
      symbols = a.slice('--symbols='.length).split(',').map((s) => s.trim()).filter(Boolean);
    }
  }

  if (!researchSafety.ingestAllowedTimeframes.includes(timeframe)) {
    throw new Error(`Unsupported --timeframe ${timeframe}. Allowed: ${researchSafety.ingestAllowedTimeframes.join(', ')}`);
  }
  if (years != null) {
    if (!Number.isFinite(years) || years < 5 || years > 10) {
      throw new Error('--years must be between 5 and 10');
    }
    // ~252 trading sessions / year for daily; calendar days ≈ years * 365 for Alpaca start date.
    lookbackDays = Math.round(years * 365);
  }
  if (lookbackDays == null || !Number.isFinite(lookbackDays) || lookbackDays <= 0) {
    lookbackDays = timeframe === '1Day'
      ? researchSafety.ingestDailyLookbackDays
      : researchSafety.ingestIntradayLookbackDays;
  }
  if (!symbols.length) symbols = warehouseSymbols().slice(0, 3);
  return { timeframe, lookbackDays, symbols, years };
}

async function main() {
  process.env.ARGUS_WRITE_RESEARCH_PARQUET = 'true';
  delete process.env.VITEST;
  if (process.env.ARGUS_RESEARCH_DIR?.includes('argus_research_test_')) {
    delete process.env.ARGUS_RESEARCH_DIR;
  }

  const opts = parseIngestArgs(process.argv.slice(2));
  const flushed = await flushAllGreenParquet();
  const inventoryAfterFlush = inspectResearchWarehouse();

  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) {
    console.log(JSON.stringify({
      ok: true,
      error: null,
      note: 'NO_ALPACA_KEYS — remote ingest skipped. Local GREEN parquet flush attempted.',
      opts,
      flushed,
      inventory: inventoryAfterFlush,
      greenBarsJsonIds: listGreenBarsJsonDatasetIds(),
      canPlaceOrders: false,
    }, null, 2));
    process.exit(flushed.some((f) => f.written) || inventoryAfterFlush.greenParquetCount > 0 ? 0 : 1);
  }

  const end = new Date();
  const start = new Date(end.getTime() - opts.lookbackDays * 86400000);
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const out = [];
  for (const symbol of opts.symbols) {
    const r = await ingestWarehouseDataset({
      symbol,
      timeframe: opts.timeframe,
      startIso,
      endIso,
      writeParquet: true,
    });
    out.push({
      symbol,
      timeframe: opts.timeframe,
      lookbackDays: opts.lookbackDays,
      quality: r.quality.quality,
      bars: r.dataset.bars.length,
      written: r.written,
      reason: r.reason,
      provenance: r.dataset.provenance,
      parquetBytesWritten: r.written === true,
    });
  }

  // Always re-flush so any GREEN bars.json without parquet bytes get PyArrow materialization.
  const postFlush = await flushAllGreenParquet();

  console.log(JSON.stringify({
    ok: true,
    canPlaceOrders: false,
    opts,
    flushed,
    postFlush,
    inventory: inspectResearchWarehouse(),
    datasets: out,
  }, null, 2));
}

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('ingest_research_warehouse.ts')
  || process.argv[1]?.replace(/\\/g, '/').endsWith('ingest_research_warehouse.js');

if (isDirectRun) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
