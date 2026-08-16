import type { Router } from 'express';
import { isTheoreticalZeroCost, researchSafety } from '../config/researchSafety';
import { assessDataQuality } from '../research/dataQuality';
import { hashCanonicalDataset } from '../research/datasetHash';
import { loadGoldenSmaDataset } from '../research/loadGoldenDataset';
import { labeledCapitals } from '../research/capitalLabels';
import { createPaperExperiment } from '../research/paperExperiment';
import { deriveLifecycleStatus, emptyEvidence, evidenceFromCanonicalRun, liveGoNoGo } from '../research/promotionEngine';
import { costStress, permutationTestPnls, sensitivityAround } from '../research/robustness';
import { coreStrategyInventory, experimentalInventory, liveCandidateReportMarkdown, researchComparisonMatrix } from '../research/strategyEvidence';
import { getVectorBTStatus, runResearchCli, compareEngines } from '../research/VectorBTService';
import { createJob, getJob, updateJob } from '../research/researchJobs';
import { runSmaCrossover, signalUsesOnlyClosesThrough } from '../research/smaCrossover';
import { runGoldenWalkForward } from '../research/walkForward';
import { backtestLimiter } from '../core/RateLimiters';
import { assertNoArbitraryCode, importResearchDataset } from '../research/importDataset';
import { listRegistered, getRegistered } from '../research/datasetRegistry';
import { freezeStrategyVersion, loadStrategySpec, listStrategySpecIds } from '../research/strategySpecs';
import { replayArgusStrategy } from '../research/argusStrategyReplay';
import { rejectionCodes } from '../research/rejectionReasons';
import { compareExecutionModels, executionModelVersion, getExecutionModel } from '../research/executionModel';
import { multipleTestingWarning } from '../research/multipleTesting';
import { rejectUnclosedDailyInIntraday } from '../research/lookAheadMtf';
import { tradingEngine } from '../engines/TradingEngine';
import { tradingSafety } from '../config/tradingSafety';
import { summarizeOrganicPaper } from '../research/organicPaper';
import { runCanonicalCoreBacktest } from '../research/canonicalNextBarEngine';
import { recordResearchRun, latestRunForStrategy } from '../research/researchRuns';
import { recordExperimentTrial, experimentLedgerSnapshot } from '../research/experimentLedger';
import { runCoreWalkForward } from '../research/coreWalkForward';
import { runCoreRobustness } from '../research/coreRobustness';
import { reconcilePaperVsResearch } from '../research/paperReconciliation';
import { tradingEdgeScore } from '../research/edgeScore';
import { db } from '../db';
import { trades } from '../db/schema';

export function mountResearchRoutes(v2Router: Router): void {
  v2Router.get('/research/vectorbt/status', async (_req, res) => {
    const status = await getVectorBTStatus();
    res.json({ ok: true, ...status, live: 'NO-GO', quantAutoEnabled: false });
  });

  v2Router.get('/research/strategies', (_req, res) => {
    res.json({
      ok: true,
      core: coreStrategyInventory(),
      experimental: experimentalInventory(),
      promotion: 'evidence_only',
    });
  });

  v2Router.get('/research/dataset/golden', (_req, res) => {
    const ds = loadGoldenSmaDataset();
    const quality = assessDataQuality(ds);
    res.json({
      ok: true,
      datasetId: ds.datasetId,
      dataHash: hashCanonicalDataset(ds),
      quality,
      barCount: ds.bars.length,
    });
  });

  v2Router.get('/research/jobs/:id', (req, res) => {
    const job = getJob(String(req.params.id));
    if (!job) return res.status(404).json({ ok: false, error: 'JOB_NOT_FOUND' });
    res.json({ ok: true, job });
  });

  v2Router.post('/research/vectorbt/backtest', backtestLimiter, async (req, res) => {
    const strategyId = String(req.body?.strategyId ?? 'GOLDEN_SMA');
    const engine = String(req.body?.engine ?? 'auto');
    if (researchSafety.experimentalStrategyIds.includes(strategyId)) {
      return res.json({
        ok: true,
        adapter: 'PROXY_NOT_FEATURE_PARITY',
        status: 'UNTESTED',
        inventedResults: false,
        note: 'Experimental/SMC is not in the CORE feature-translation set.',
        canPlaceOrders: false,
      });
    }
    if (researchSafety.coreStrategyIds.includes(strategyId)) {
      const bars = Array.isArray(req.body?.bars) ? req.body.bars : [];
      if (bars.length === 0) {
        return res.json({
          ok: true,
          adapter: 'FEATURE_TRANSLATION',
          status: 'UNTESTED',
          data: 'UNAVAILABLE',
          inventedResults: false,
          note: researchSafety.proxyAdapterNote,
          canPlaceOrders: false,
        });
      }
      const py = await runResearchCli({ job: 'core_feature_parity', bars, strategyId, engine }) as any;
      return res.json({
        ok: py?.ok !== false,
        adapter: 'FEATURE_TRANSLATION',
        python: py,
        inventedResults: false,
        canPlaceOrders: false,
      });
    }
    if (!researchSafety.allowlistedStrategies.includes(strategyId)) {
      return res.status(400).json({ ok: false, error: 'STRATEGY_NOT_ALLOWLISTED' });
    }
    const ds = loadGoldenSmaDataset();
    const quality = assessDataQuality(ds);
    if (!quality.backtestAllowed) return res.status(400).json({ ok: false, error: 'DATA_QUALITY_RED', quality });
    const job = createJob({
      strategyId,
      datasetId: ds.datasetId,
      parameters: { fast: researchSafety.goldenSmaFast, slow: researchSafety.goldenSmaSlow, engine },
      engine,
    });
    updateJob(job.jobId, { status: 'RUNNING', startedAt: new Date().toISOString() });
    const argus = runSmaCrossover(ds.bars, researchSafety.goldenSmaFast, researchSafety.goldenSmaSlow, researchSafety.goldenInitialCapital);
    let pythonResult: any = null;
    try {
      pythonResult = await runResearchCli({
        job: 'golden_sma',
        engine,
        fast: researchSafety.goldenSmaFast,
        slow: researchSafety.goldenSmaSlow,
        capital: researchSafety.goldenInitialCapital,
      });
    } catch (e: any) {
      pythonResult = { ok: false, error: e.message, engineUsed: 'unavailable' };
    }
    const pyTrades = Number(pythonResult?.tradeCount ?? pythonResult?.result?.tradeCount ?? NaN);
    const pyPnl = Number(pythonResult?.netPnl ?? pythonResult?.result?.netPnl ?? NaN);
    const engineUsed = String(pythonResult?.engineUsed ?? 'python_fallback_or_unavailable');
    let parity: { status: 'PASS' | 'ENGINE_MISMATCH' | 'PYTHON_UNAVAILABLE'; maxDifference: number } = {
      status: 'PYTHON_UNAVAILABLE',
      maxDifference: 0,
    };
    if (Number.isFinite(pyTrades) && Number.isFinite(pyPnl)) {
      const cmp = compareEngines({ tradeCount: argus.tradeCount, netPnl: argus.netPnl }, { tradeCount: pyTrades, netPnl: pyPnl });
      parity = cmp;
    }
    if (engine === 'rust' && pythonResult?.rustAccelerationUnavailable) {
      updateJob(job.jobId, {
        status: 'COMPLETED',
        completedAt: new Date().toISOString(),
        engineUsed: 'RUST_ACCELERATION_UNAVAILABLE',
        result: { rustAccelerationUnavailable: true, argus },
      });
      return res.json({
        ok: true,
        jobId: job.jobId,
        rustAccelerationUnavailable: true,
        engineUsed: 'RUST_ACCELERATION_UNAVAILABLE',
        argus,
        parity,
        quality,
        dataHash: hashCanonicalDataset(ds),
        canPlaceOrders: false,
      });
    }
    updateJob(job.jobId, {
      status: 'COMPLETED',
      completedAt: new Date().toISOString(),
      engineUsed,
      result: { argus, pythonResult, parity },
    });
    res.json({
      ok: true,
      jobId: job.jobId,
      engineUsed,
      argus,
      python: pythonResult,
      parity,
      quality,
      dataHash: hashCanonicalDataset(ds),
      lookAheadModel: argus.lookAheadModel,
      canPlaceOrders: false,
      label: 'TECHNICAL_BACKTEST',
    });
  });

  v2Router.post('/research/vectorbt/walk-forward', backtestLimiter, (_req, res) => {
    const ds = loadGoldenSmaDataset();
    const wf = runGoldenWalkForward(ds.bars);
    res.json({ ok: true, ...wf, canPlaceOrders: false });
  });

  v2Router.post('/research/vectorbt/robustness', backtestLimiter, (_req, res) => {
    const ds = loadGoldenSmaDataset();
    const { goldenSmaFast: fast, goldenSmaSlow: slow, goldenInitialCapital: capital } = researchSafety;
    const base = runSmaCrossover(ds.bars, fast, slow, capital);
    const perm = permutationTestPnls(base.trades.map((t) => t.pnl));
    const sens = sensitivityAround(ds.bars, fast, slow, capital);
    const cost = costStress(ds.bars, fast, slow, capital, researchSafety.commissionPerShare || 0.01);
    res.json({
      ok: true,
      permutation: perm,
      sensitivity: { ...sens, flag: sens.fragile ? 'FRAGILE_PARAMETERIZATION' : null },
      costStress: { ...cost, flag: cost.costFragile ? 'COST_FRAGILE' : null },
      canPlaceOrders: false,
    });
  });

  v2Router.post('/research/vectorbt/parameter-sweep', backtestLimiter, (_req, res) => {
    const ds = loadGoldenSmaDataset();
    const trainEnd = Math.floor(ds.bars.length * 0.7);
    const train = ds.bars.slice(0, trainEnd);
    const test = ds.bars.slice(trainEnd);
    const rows = [];
    for (const fast of [2, 3, 4]) {
      for (const slow of [6, 8, 10]) {
        if (fast >= slow) continue;
        const tr = runSmaCrossover(train, fast, slow, researchSafety.goldenInitialCapital);
        rows.push({ fast, slow, trainNetPnl: tr.netPnl, trainTrades: tr.tradeCount });
      }
    }
    const best = rows.slice().sort((a, b) => b.trainNetPnl - a.trainNetPnl)[0];
    const oos = best
      ? runSmaCrossover(test, best.fast, best.slow, researchSafety.goldenInitialCapital)
      : null;
    res.json({
      ok: true,
      optimizedOn: 'TRAIN_ONLY',
      testUntouchedDuringSweep: true,
      rows,
      selectedOnTrain: best,
      untouchedTest: oos,
      canPlaceOrders: false,
    });
  });

  v2Router.get('/research/promotion/:strategyId', (req, res) => {
    const id = String(req.params.strategyId);
    const rec = latestRunForStrategy(id);
    const e = rec ? evidenceFromCanonicalRun(rec.manifest) : emptyEvidence(id);
    res.json({
      ok: true,
      status: deriveLifecycleStatus(e),
      evidence: e,
      live: liveGoNoGo(e),
      cannotSetStatusByConfig: true,
      fromArtifact: !!rec,
      zeroCostBlocksPromotion: isTheoreticalZeroCost(),
    });
  });

  v2Router.get('/research/paper-experiment', (_req, res) => {
    const spec = createPaperExperiment({
      experimentId: 'ARGUS_CORE_2026_Q3',
      capital: 1000,
      universe: ['SPY'],
      timeframe: '5m',
    });
    res.json({ ok: true, spec, frozen: true, inventedTrades: false });
  });

  v2Router.get('/research/capital-labels', (_req, res) => {
    res.json({
      ok: true,
      ...labeledCapitals({
        researchInitialCapital: researchSafety.goldenInitialCapital,
        paperInitialCapital: tradingSafety.internalPaperDefaultCash,
        defaultMaxTradeSizeDollars: tradingSafety.defaultMaxTradeSizeDollars,
        argusAllocationBudget: Number(tradingEngine.state.budget ?? 0),
        brokerEquity: null,
      }),
      note: 'paperInitialCapital = InternalPaperBroker seed. defaultMaxTradeSizeDollars = order-notional fallback. argusAllocationBudget = settings.budget. brokerEquity is null when unavailable — never 10000. Not interchangeable.',
    });
  });

  v2Router.get('/research/live-candidate-report.md', (_req, res) => {
    res.type('text/markdown').send(liveCandidateReportMarkdown());
  });

  v2Router.get('/research/look-ahead-check', (_req, res) => {
    const ds = loadGoldenSmaDataset();
    const i = 10;
    const ok = signalUsesOnlyClosesThrough(ds.bars, researchSafety.goldenSmaFast, researchSafety.goldenSmaSlow, i);
    const mtf = rejectUnclosedDailyInIntraday({
      decisionTimestamp: 1000,
      dailyBarOpenMs: 0,
      dailyBarCloseMs: 5000,
    });
    res.json({ ok: true, pass: ok, unclosedDaily: mtf, canPlaceOrders: false });
  });

  v2Router.get('/research/datasets', (_req, res) => {
    res.json({ ok: true, datasets: listRegistered(), canPlaceOrders: false });
  });

  v2Router.get('/research/datasets/:id', (req, res) => {
    const row = getRegistered(String(req.params.id));
    if (!row) return res.status(404).json({ ok: false, error: 'NO_DATA' });
    res.json({ ok: true, meta: row.meta, barCount: row.dataset.bars.length, provenance: row.meta.provenance, canPlaceOrders: false });
  });

  v2Router.post('/research/datasets/import', backtestLimiter, (req, res) => {
    try {
      assertNoArbitraryCode(req.body ?? {});
      const provenance = req.body?.provenance;
      if (provenance !== 'REAL_MARKET_DATA' && provenance !== 'UNIT_FIXTURE' && provenance !== 'SYNTHETIC_TEST_DATA' && provenance !== 'UNKNOWN') {
        return res.status(400).json({ ok: false, error: 'provenance required' });
      }
      const meta = importResearchDataset({
        datasetId: String(req.body.datasetId ?? `imp_${Date.now()}`),
        symbol: String(req.body.symbol ?? 'UNKNOWN'),
        provenance,
        csv: typeof req.body.csv === 'string' ? req.body.csv : undefined,
        bars: Array.isArray(req.body.bars) ? req.body.bars : undefined,
        market: req.body.market,
        frequency: req.body.frequency,
        adjustmentPolicy: req.body.adjustmentPolicy,
        source: req.body.source,
      });
      res.json({ ok: true, meta, canPlaceOrders: false });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e.message, canPlaceOrders: false });
    }
  });

  v2Router.get('/research/strategy/:id/spec', (req, res) => {
    const spec = loadStrategySpec(String(req.params.id));
    if (!spec) return res.status(404).json({ ok: false, error: 'NO_DATA' });
    res.json({ ok: true, spec, canPlaceOrders: false });
  });

  v2Router.get('/research/strategy/:id/evidence', (req, res) => {
    const id = String(req.params.id);
    const rec = latestRunForStrategy(id);
    const e = rec ? evidenceFromCanonicalRun(rec.manifest) : emptyEvidence(id);
    res.json({
      ok: true,
      status: deriveLifecycleStatus(e),
      evidence: e,
      live: liveGoNoGo(e),
      specIds: listStrategySpecIds(),
      edge: tradingEdgeScore(e),
      canPlaceOrders: false,
      fromArtifact: !!rec,
    });
  });

  v2Router.post('/research/replay/argus', backtestLimiter, (req, res) => {
    try {
      assertNoArbitraryCode(req.body ?? {});
      const strategyId = String(req.body?.strategyId ?? '');
      const ds = loadGoldenSmaDataset();
      const result = replayArgusStrategy({
        strategyId,
        bars: ds.bars,
        provenance: ds.provenance ?? 'UNIT_FIXTURE',
      });
      res.json({ ok: true, ...result, execution: getExecutionModel(), canPlaceOrders: false });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e.message, canPlaceOrders: false });
    }
  });

  v2Router.get('/research/comparison-matrix', (_req, res) => {
    res.json({ ok: true, ...researchComparisonMatrix(), canPlaceOrders: false });
  });

  v2Router.get('/research/rejection-catalog', (_req, res) => {
    res.json({ ok: true, codes: rejectionCodes, canPlaceOrders: false });
  });

  v2Router.get('/research/multiple-testing', (req, res) => {
    const trials = Number(req.query.trials ?? 0);
    res.json({ ok: true, ...multipleTestingWarning(trials), canPlaceOrders: false });
  });

  v2Router.get('/research/execution-models', (_req, res) => {
    const mismatch = compareExecutionModels('NEXT_BAR_OPEN', 'SAME_BAR_CLOSE');
    res.json({
      ok: true,
      executionModelVersion: executionModelVersion(),
      canonical: getExecutionModel('NEXT_BAR_OPEN'),
      backtestEngine: getExecutionModel('SAME_BAR_CLOSE'),
      engineCompare: mismatch,
      canPlaceOrders: false,
    });
  });

  v2Router.get('/research/strategy/:id/version', (req, res) => {
    const frozen = freezeStrategyVersion(String(req.params.id));
    if (!frozen) return res.status(404).json({ ok: false, error: 'NO_DATA', canPlaceOrders: false });
    res.json({ ok: true, ...frozen, canPlaceOrders: false });
  });

  v2Router.get('/research/organic-paper', async (_req, res) => {
    let rows: Array<{ status: string; side: string; profitLoss: number | null; traceId: string | null; reasoning: string | null }> = [];
    try {
      rows = await db.select({
        status: trades.status,
        side: trades.side,
        profitLoss: trades.profitLoss,
        traceId: trades.traceId,
        reasoning: trades.reasoning,
      }).from(trades);
    } catch {
      rows = [];
    }
    const summary = summarizeOrganicPaper(rows, researchSafety.minPaperTrades);
    const rec = latestRunForStrategy(researchSafety.coreStrategyIds[0] ?? 'MOMENTUM_BREAKOUT');
    const recon = reconcilePaperVsResearch(rec?.manifest ?? null, rows);
    res.json({
      ok: true,
      ...summary,
      reconciliation: recon,
      invented: false,
      live: 'NO-GO',
      canPlaceOrders: false,
    });
  });

  v2Router.post('/research/canonical/core', backtestLimiter, (req, res) => {
    try {
      assertNoArbitraryCode(req.body ?? {});
      const strategyId = String(req.body?.strategyId ?? 'MOMENTUM_BREAKOUT');
      const ds = loadGoldenSmaDataset();
      const result = runCanonicalCoreBacktest({ strategyId, dataset: ds });
      recordExperimentTrial(strategyId, result.datasetHash);
      const rec = recordResearchRun(result);
      res.json({
        ok: true,
        runId: rec.runId,
        ...result,
        ledger: experimentLedgerSnapshot(),
        live: 'NO-GO',
        canPlaceOrders: false,
      });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e.message, canPlaceOrders: false });
    }
  });

  v2Router.post('/research/canonical/walk-forward', backtestLimiter, (req, res) => {
    const strategyId = String(req.body?.strategyId ?? 'MOMENTUM_BREAKOUT');
    const ds = loadGoldenSmaDataset();
    const wf = runCoreWalkForward(strategyId, ds);
    res.json({ ok: true, ...wf, canPlaceOrders: false, live: 'NO-GO' });
  });

  v2Router.post('/research/canonical/robustness', backtestLimiter, (req, res) => {
    const strategyId = String(req.body?.strategyId ?? 'MOMENTUM_BREAKOUT');
    const ds = loadGoldenSmaDataset();
    const fromSignals = replayArgusStrategy({ strategyId, bars: ds.bars, provenance: ds.provenance ?? 'UNIT_FIXTURE' });
    const report = runCoreRobustness(ds.bars, fromSignals.signals);
    res.json({ ok: true, ...report, canPlaceOrders: false, live: 'NO-GO' });
  });

  v2Router.get('/research/edge-score', (_req, res) => {
    const e = emptyEvidence('MOMENTUM_BREAKOUT');
    res.json({ ok: true, ...tradingEdgeScore(e), live: 'NO-GO', canPlaceOrders: false });
  });

  v2Router.get('/research/experiment-ledger', (_req, res) => {
    res.json({ ok: true, ...experimentLedgerSnapshot(), canPlaceOrders: false });
  });
}
