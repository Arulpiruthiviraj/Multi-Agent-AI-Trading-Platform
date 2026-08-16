/**
 * Ingest Alpaca 1Day REAL_MARKET_DATA (no fabricated bars) and run canonical NEXT_BAR
 * OOS / walk-forward / robustness with configured costs. Cannot place orders.
 * Does not enable LIVE.
 *
 * Usage: npx tsx scripts/run_canonical_research.ts
 */
import dotenv from 'dotenv';
dotenv.config();
import { ingestWarehouseDataset } from '../src/server/research/ingestAlpacaWarehouse';
import { researchSafety } from '../src/server/config/researchSafety';
import { runCanonicalCoreBacktest } from '../src/server/research/canonicalNextBarEngine';
import { runCoreWalkForward } from '../src/server/research/coreWalkForward';
import { runCoreRobustness } from '../src/server/research/coreRobustness';
import { replayArgusStrategy } from '../src/server/research/argusStrategyReplay';
import { recordResearchRun } from '../src/server/research/researchRuns';
import { writeDatasetSidecar, writeDatasetBars } from '../src/server/research/parquetStore';

async function main() {
  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) {
    console.log(JSON.stringify({
      ok: false,
      error: 'NO_ALPACA_KEYS',
      canPlaceOrders: false,
      live: 'NO-GO',
      note: 'No bars fabricated. Organic paper and OOS remain UNAVAILABLE.',
    }));
    process.exit(0);
  }
  process.env.ARGUS_WRITE_RESEARCH_PARQUET = process.env.ARGUS_WRITE_RESEARCH_PARQUET || 'true';
  const end = new Date();
  const start = new Date(end.getTime() - researchSafety.ingestDailyLookbackDays * 86400000);
  const ingest = await ingestWarehouseDataset({
    symbol: 'SPY',
    timeframe: '1Day',
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    writeParquet: true,
  });
  writeDatasetSidecar(ingest.dataset);
  if (ingest.quality.quality === 'GREEN' && ingest.dataset.provenance === 'REAL_MARKET_DATA') {
    writeDatasetBars(ingest.dataset);
  }

  const strategies = researchSafety.coreStrategyIds;
  const reports = [];
  for (const strategyId of strategies) {
    if (ingest.quality.quality !== 'GREEN' || ingest.dataset.provenance !== 'REAL_MARKET_DATA') {
      reports.push({
        strategyId,
        skipped: true,
        reason: ingest.reason,
        quality: ingest.quality.quality,
        provenance: ingest.dataset.provenance,
        oos: 'NOT_RUN',
        wfo: 'NOT_RUN',
        robustness: 'NOT_RUN',
      });
      continue;
    }
    const bt = runCanonicalCoreBacktest({ strategyId, dataset: ingest.dataset });
    recordResearchRun(bt);
    const wf = runCoreWalkForward(strategyId, ingest.dataset);
    const replay = replayArgusStrategy({
      strategyId,
      bars: ingest.dataset.bars,
      provenance: ingest.dataset.provenance ?? 'UNKNOWN',
    });
    const rob = runCoreRobustness(ingest.dataset.bars, replay.signals);
    reports.push({
      strategyId,
      skipped: false,
      quality: ingest.quality.quality,
      provenance: ingest.dataset.provenance,
      barCount: ingest.dataset.bars.length,
      backtestPass: bt.backtestPass,
      rejection: bt.rejection,
      oosTrades: bt.metrics.tradeCount,
      oosExpectancy: bt.metrics.expectancy,
      wfoStatus: wf.status,
      wfoFolds: wf.foldCount,
      wfoMedianTestExpectancy: wf.medianTestExpectancy,
      robustness: rob.label,
      robustnessCenterNetPnl: rob.centerNetPnl,
      promotable: false,
      canPlaceOrders: false,
    });
  }

  console.log(JSON.stringify({
    ok: true,
    canPlaceOrders: false,
    live: 'NO-GO',
    enableLiveTrading: false,
    ingest: {
      symbol: 'SPY',
      timeframe: '1Day',
      bars: ingest.dataset.bars.length,
      quality: ingest.quality.quality,
      provenance: ingest.dataset.provenance,
      fetchStatus: ingest.fetchStatus,
      httpStatus: ingest.httpStatus,
      errorDetail: ingest.errorDetail,
      written: ingest.written,
      reason: ingest.reason,
      issues: ingest.quality.issues,
    },
    costs: {
      commissionPerShare: researchSafety.commissionPerShare,
      spreadBps: researchSafety.spreadBps,
      slippageBps: researchSafety.slippageBps,
    },
    reports,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
