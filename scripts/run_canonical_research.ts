/**
 * Flush GREEN parquet (if needed), load REAL_MARKET_DATA datasets, and run canonical
 * NEXT_BAR OOS / walk-forward / robustness for CORE strategies with configured costs.
 * Persists runs under data/research/runs/ and baseline_index.json for strategyEvidence.
 * Cannot place orders. Does not enable LIVE. Never fabricates PASS.
 *
 * Usage: npx tsx scripts/run_canonical_research.ts
 */
import dotenv from 'dotenv';
dotenv.config();
import { researchSafety } from '../src/server/config/researchSafety';
import { runCanonicalCoreBacktest } from '../src/server/research/canonicalNextBarEngine';
import { runCoreWalkForward } from '../src/server/research/coreWalkForward';
import { applyRobustnessGates, runCoreRobustness } from '../src/server/research/coreRobustness';
import { replayArgusStrategy } from '../src/server/research/argusStrategyReplay';
import {
  persistBaselineEvidenceIndex,
  recordEvidenceGates,
  recordResearchRun,
} from '../src/server/research/researchRuns';
import {
  flushAllGreenParquet,
  listGreenBarsJsonDatasetIds,
  loadWrittenDataset,
  parquetBytesExistOnDisk,
} from '../src/server/research/parquetStore';
import { evidenceFromCanonicalRun, deriveLifecycleStatus, liveGoNoGo } from '../src/server/research/promotionEngine';
import { inspectResearchWarehouse } from '../src/server/research/warehouseInventory';
import type { CanonicalDataset } from '../src/server/research/ohlcvTypes';

function pickPrimaryDataset(ids: string[]): CanonicalDataset | null {
  // Prefer longest GREEN 1Day series (CORE research timeframe), SPY first, else any symbol.
  const loaded = ids
    .map((id) => loadWrittenDataset(id))
    .filter((ds): ds is CanonicalDataset => !!ds
      && ds.qualityStatus === 'GREEN'
      && ds.provenance === 'REAL_MARKET_DATA'
      && Array.isArray(ds.bars)
      && ds.bars.length > 0);

  const daily = loaded.filter((ds) => /1Day/i.test(ds.frequency) || /_1Day_/i.test(ds.datasetId));
  const pool = daily.length ? daily : loaded;
  if (!pool.length) return null;

  const spyDaily = pool.filter((ds) => ds.symbol === 'SPY');
  const ranked = (spyDaily.length ? spyDaily : pool)
    .slice()
    .sort((a, b) => b.bars.length - a.bars.length);
  return ranked[0] ?? null;
}

async function main() {
  process.env.ARGUS_WRITE_RESEARCH_PARQUET = process.env.ARGUS_WRITE_RESEARCH_PARQUET || 'true';
  delete process.env.VITEST;
  if (process.env.ARGUS_RESEARCH_DIR?.includes('argus_research_test_')) {
    delete process.env.ARGUS_RESEARCH_DIR;
  }

  const flushed = await flushAllGreenParquet();
  const ids = listGreenBarsJsonDatasetIds().filter((id) => parquetBytesExistOnDisk(id));
  const dataset = pickPrimaryDataset(ids);

  if (!dataset || dataset.qualityStatus !== 'GREEN' || dataset.provenance !== 'REAL_MARKET_DATA') {
    console.log(JSON.stringify({
      ok: false,
      error: 'NO_GREEN_PARQUET_DATASET',
      canPlaceOrders: false,
      live: 'NO-GO',
      flushed,
      inventory: inspectResearchWarehouse(),
      note: 'Need GREEN REAL_MARKET_DATA with physical .parquet. Run ingest_research_warehouse.ts first.',
    }, null, 2));
    process.exit(1);
  }

  if (!parquetBytesExistOnDisk(dataset.datasetId)) {
    console.log(JSON.stringify({
      ok: false,
      error: 'PARQUET_BYTES_NOT_WRITTEN',
      datasetId: dataset.datasetId,
      canPlaceOrders: false,
      live: 'NO-GO',
    }, null, 2));
    process.exit(1);
  }

  const strategies = researchSafety.coreStrategyIds;
  const reports = [];
  const baselineEntries = [];

  for (const strategyId of strategies) {
    const bt = runCanonicalCoreBacktest({ strategyId, dataset });
    const rec = recordResearchRun(bt);
    let evidence = evidenceFromCanonicalRun(bt);

    const wf = runCoreWalkForward(strategyId, dataset);
    const walkForwardPass =
      wf.status === 'COMPLETED' &&
      wf.foldCount >= researchSafety.minWalkForwardWindows &&
      (wf.medianTestExpectancy ?? 0) > 0;

    const replay = replayArgusStrategy({
      strategyId,
      bars: dataset.bars,
      provenance: dataset.provenance ?? 'UNKNOWN',
    });
    const rob = runCoreRobustness(dataset.bars, replay.signals);
    evidence = applyRobustnessGates(evidence, rob);

    // Honest OOS: sufficient closed NEXT_BAR trades + positive expectancy (no fabrication).
    const oosPass =
      bt.backtestPass === true &&
      bt.metrics.tradeCount >= researchSafety.minOosTrades &&
      (bt.metrics.expectancy ?? 0) > 0;

    evidence = {
      ...evidence,
      oosPass,
      walkForwardPass,
      qualityStatus: 'GREEN',
      parquetBytesWritten: true,
      dataQualityPass: true,
      dataProvenance: 'REAL_MARKET_DATA',
      executionModel: 'NEXT_BAR_OPEN',
      datasetId: dataset.datasetId,
    };

    const gateSnapshot = {
      strategyId,
      datasetId: dataset.datasetId,
      datasetHash: bt.datasetHash,
      provenance: dataset.provenance,
      quality: 'GREEN',
      parquetBytesWritten: true,
      executionModel: 'NEXT_BAR_OPEN',
      backtestPass: evidence.backtestPass,
      oosPass: evidence.oosPass,
      walkForwardPass: evidence.walkForwardPass,
      oosTrades: bt.metrics.tradeCount,
      oosExpectancy: bt.metrics.expectancy,
      wfoStatus: wf.status,
      wfoFolds: wf.foldCount,
      wfoMedianTestExpectancy: wf.medianTestExpectancy,
      robustnessLabel: rob.label,
      robustnessGates: rob.gates ?? null,
      lifecycle: deriveLifecycleStatus(evidence),
      live: liveGoNoGo(evidence).live,
      strategyParity: 'FEATURE_SUBSET_PARITY',
      fullStrategyParity: false,
    };

    recordEvidenceGates(rec.runId, gateSnapshot);
    baselineEntries.push({ strategyId, runId: rec.runId, evidence, gateSnapshot });

    reports.push({
      strategyId,
      runId: rec.runId,
      skipped: false,
      quality: 'GREEN',
      provenance: dataset.provenance,
      barCount: dataset.bars.length,
      parquetBytesWritten: true,
      executionModel: 'NEXT_BAR_OPEN',
      backtestPass: evidence.backtestPass,
      oosPass: evidence.oosPass,
      walkForwardPass: evidence.walkForwardPass,
      rejection: bt.rejection,
      oosTrades: bt.metrics.tradeCount,
      oosExpectancy: bt.metrics.expectancy,
      wfoStatus: wf.status,
      wfoFolds: wf.foldCount,
      wfoMedianTestExpectancy: wf.medianTestExpectancy,
      robustness: rob.label,
      robustnessCenterNetPnl: rob.centerNetPnl,
      robustnessGates: rob.gates ?? null,
      lifecycle: deriveLifecycleStatus(evidence),
      promotable: false,
      canPlaceOrders: false,
      live: 'NO-GO',
    });
  }

  const indexPath = persistBaselineEvidenceIndex(baselineEntries);

  console.log(JSON.stringify({
    ok: true,
    canPlaceOrders: false,
    live: 'NO-GO',
    enableLiveTrading: false,
    flushed,
    inventory: inspectResearchWarehouse(),
    dataset: {
      datasetId: dataset.datasetId,
      symbol: dataset.symbol,
      timeframe: dataset.frequency,
      bars: dataset.bars.length,
      quality: dataset.qualityStatus,
      provenance: dataset.provenance,
      parquetBytesWritten: true,
    },
    costs: {
      commissionPerShare: researchSafety.commissionPerShare,
      spreadBps: researchSafety.spreadBps,
      slippageBps: researchSafety.slippageBps,
    },
    baselineIndexPath: indexPath,
    reports,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
