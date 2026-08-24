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
import { backtestLimiter, replayLabLimiter } from '../core/RateLimiters';
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
import { inspectResearchWarehouse } from '../research/warehouseInventory';
import { tradingEdgeScore } from '../research/edgeScore';
import { db } from '../db';
import { trades } from '../db/schema';
import { pauseReplay, resumeReplay, stopReplay, stepReplay, getReplayRun, getReplayTrades, getReplayEquity } from '../replay/FullArgusReplayEngine';
import { exportReplayManifest, readReplayArtifact, exportTradesCsv, exportEquityCsv, exportRejectionsCsv, exportMissedOpportunitiesCsv, exportMarkdownReport, exportZipArchive, isValidReplayId } from '../replay/replayStore';

export function mountResearchRoutes(v2Router: Router): void {
  v2Router.get('/research/vectorbt/status', async (_req, res) => {
    const status = await getVectorBTStatus();
    res.json({
      ok: true,
      ...status,
      strategyParity: 'FEATURE_SUBSET_PARITY',
      fullStrategyParity: false,
      promotionEvidence: false,
      note: 'VectorBT/Python is FEATURE_SUBSET only until full StrategyContext parity. Not LIVE evidence.',
      live: 'NO-GO',
      quantAutoEnabled: false,
      canPlaceOrders: false,
    });
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
          adapter: 'FEATURE_SUBSET_PARITY',
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
        adapter: 'FEATURE_SUBSET_PARITY',
        vectorAdapter: py?.adapter || 'FEATURE_VECTOR_PARITY_ESTABLISHED',
        python: py,
        inventedResults: false,
        note: 'Strategy-level Python/VectorBT is FEATURE_SUBSET_PARITY (not full StrategyContext). Vector job may report FEATURE_VECTOR_PARITY_ESTABLISHED for BOS/RVOL/Keltner/S-R only.',
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

  v2Router.get('/research/promotion/:strategyId', async (req, res) => {
    const id = String(req.params.strategyId);
    const rec = latestRunForStrategy(id);
    const e = rec ? evidenceFromCanonicalRun(rec.manifest) : emptyEvidence(id);
    try {
      const rows = await db.select({
        status: trades.status,
        side: trades.side,
        profitLoss: trades.profitLoss,
        traceId: trades.traceId,
        reasoning: trades.reasoning,
        executionEnvironment: trades.executionEnvironment,
        timestamp: trades.timestamp,
        filledAt: trades.filledAt,
      }).from(trades);
      const paper = summarizeOrganicPaper(rows, researchSafety.minPaperTrades);
      e.paperTrades = paper.closedTradeCount;
      e.paperSessions = paper.sessionCount;
      e.paperExpectancyPositive = paper.closedTradeCount >= researchSafety.minPaperTrades && (paper.expectancy ?? 0) > 0;
    } catch {
      // Missing DB is not invented paper.
    }
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
    try {
    let rows: Array<{ status: string; side: string; profitLoss: number | null; traceId: string | null; reasoning: string | null }> = [];
    try {
      rows = await db.select({
        status: trades.status,
        side: trades.side,
        profitLoss: trades.profitLoss,
        traceId: trades.traceId,
        reasoning: trades.reasoning,
        executionEnvironment: trades.executionEnvironment,
        timestamp: trades.timestamp,
        filledAt: trades.filledAt,
      }).from(trades);
    } catch {
      rows = [];
    }
    const summary = summarizeOrganicPaper(rows, researchSafety.minPaperTrades);
    const rec = latestRunForStrategy(researchSafety.coreStrategyIds[0] ?? 'MOMENTUM_BREAKOUT');
    const recon = reconcilePaperVsResearch(rec?.manifest ?? null, rows);
    const closed = summary.closedTradeCount ?? 0;
    const sessions = summary.sessionCount ?? 0;
    const { tradingEngine } = await import('../engines/TradingEngine');
    const { derivePaperSoakStatus } = await import('../research/paperSoakState');
    const soak = derivePaperSoakStatus({
      closedTradeCount: closed,
      sessionCount: sessions,
      tradingState: tradingEngine.state.tradingState,
      reconciliationBlocking: tradingEngine.state.tradingState === 'TRADING_PAUSED',
    });
    const { classifyMarketSession } = await import('../replay/marketSession');
    const rawSession = classifyMarketSession(Date.now(), 'America/New_York', true);
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date());
    const weekend = weekday === 'Sat' || weekday === 'Sun';
    let marketSession: 'MARKET_OPEN' | 'PRE_MARKET' | 'AFTER_HOURS' | 'WEEKEND_CLOSED' | 'CLOSED' = 'CLOSED';
    if (weekend) marketSession = 'WEEKEND_CLOSED';
    else if (rawSession === 'REGULAR') marketSession = 'MARKET_OPEN';
    else if (rawSession === 'PRE_MARKET') marketSession = 'PRE_MARKET';
    else if (rawSession === 'AFTER_HOURS') marketSession = 'AFTER_HOURS';
    else marketSession = 'CLOSED';
    res.json({
      ok: true,
      ...summary,
      minPaperTrades: researchSafety.minPaperTrades,
      minPaperSessions: researchSafety.minPaperSessions,
      marketSession,
      exclusions: ['REPLAY', 'EXTERNAL_SYNC', 'PRE_EXISTING_RECONCILED', 'HISTORICAL_SIMULATION', 'DIAG*', 'MANUAL_OVERRIDE'],
      soak: {
        ...soak,
        // Backward-compatible dual field
        status: soak.status,
        legacyStatus: soak.legacyStatus,
      },
      reconciliation: recon,
      invented: false,
      live: 'NO-GO',
      canPlaceOrders: false,
    });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('[organic-paper] handler failed:', message);
      res.status(500).json({ ok: false, error: message, canPlaceOrders: false, live: 'NO-GO' });
    }
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
    res.json({
      ok: true,
      ...report,
      evidenceGates: report.gates,
      canPlaceOrders: false,
      live: 'NO-GO',
      note: 'Gates may pass only with sufficient after-cost sample. LIVE still NO-GO without paper + manual approval.',
    });
  });

  v2Router.get('/research/warehouse', (_req, res) => {
    const inventory = inspectResearchWarehouse();
    res.json({
      ok: true,
      ...inventory,
      canPlaceOrders: false,
      live: 'NO-GO',
      note: inventory.note,
    });
  });

  v2Router.get('/research/edge-score', (_req, res) => {
    const e = emptyEvidence('MOMENTUM_BREAKOUT');
    res.json({ ok: true, ...tradingEdgeScore(e), live: 'NO-GO', canPlaceOrders: false });
  });

  v2Router.get('/research/experiment-ledger', (_req, res) => {
    res.json({ ok: true, ...experimentLedgerSnapshot(), canPlaceOrders: false });
  });

  v2Router.get('/research/replay/providers', async (_req, res) => {
    const { listHistoricalProviders } = await import('../replay/HistoricalDataProviderRegistry');
    res.json({ ok: true, providers: listHistoricalProviders(), live: 'NO-GO', canPlaceOrders: false });
  });

  v2Router.post('/research/datasets/download', replayLabLimiter, async (req, res) => {
    try {
      assertNoArbitraryCode(req.body ?? {});
      const { getHistoricalProvider } = await import('../replay/HistoricalDataProviderRegistry');
      const providerId = String(req.body?.provider || 'golden_replay');
      const symbol = String(req.body?.symbol || 'AAPL');
      const frequency = String(req.body?.frequency || '1Day');
      const provider = getHistoricalProvider(providerId);
      if (!provider) return res.status(404).json({ ok: false, error: 'DATA_PROVIDER_UNAVAILABLE' });
      const startMs = Date.parse(String(req.body?.startDate || '2024-01-02'));
      const endMs = Date.parse(String(req.body?.endDate || '2024-12-31'));
      const fetched = await provider.fetch({ symbol, startMs, endMs, frequency });
      if ('error' in fetched) return res.status(409).json({ ok: false, ...fetched, canPlaceOrders: false });
      const quality = assessDataQuality(fetched);
      res.json({
        ok: true,
        datasetId: fetched.datasetId,
        dataHash: hashCanonicalDataset(fetched),
        quality,
        barCount: fetched.bars.length,
        provenance: fetched.provenance,
        canPlaceOrders: false,
        live: 'NO-GO',
      });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e.message, canPlaceOrders: false });
    }
  });

  v2Router.post('/research/replay/create', replayLabLimiter, async (req, res) => {
    try {
      assertNoArbitraryCode(req.body ?? {});
      const { createReplayRun } = await import('../replay/FullArgusReplayEngine');
      const row = await createReplayRun(req.body || {});
      // server.ts's 15s /api request-timeout watchdog can already have sent a 504 for a slow real-
      // provider dataset load by the time this resolves - guard instead of throwing
      // ERR_HTTP_HEADERS_SENT (the same crash pattern already seen from other slow routes).
      if (!res.headersSent) res.json({ ok: true, ...row, canPlaceOrders: false });
    } catch (e: any) {
      if (!res.headersSent) res.status(400).json({ ok: false, error: e.message, canPlaceOrders: false, live: 'NO-GO' });
    }
  });

  v2Router.post('/research/replay/:id/start', replayLabLimiter, async (req, res) => {
    const { startReplay } = await import('../replay/FullArgusReplayEngine');
    const asyncMode = req.query.async === '1' || req.body?.async === true;
    const row = await startReplay(String(req.params.id), { async: asyncMode });
    if (res.headersSent) return;
    if (row && (row as any).ok === false) {
      // REPLAY_NOT_FOUND (the id was never created / expired from the in-memory runs Map) stays a
      // real 404. Any other failure means the run DOES exist - it just never produced a runnable
      // session (e.g. its data provider returned no dataset at creation time) or is blocked by a
      // real state conflict (LIVE mode, another active session) - a distinct 409 so the UI/caller
      // can tell "this id is unknown" apart from "this id exists, here's the real reason it can't
      // start" instead of both surfacing as the same generic REPLAY_NOT_FOUND.
      const status = (row as any).error === 'REPLAY_NOT_FOUND' ? 404 : 409;
      return res.status(status).json(row);
    }
    res.json({ ok: true, ...(row || {}), canPlaceOrders: false, live: 'NO-GO' });
  });

  v2Router.post('/research/replay/:id/pause', (req, res) => {
    res.json(pauseReplay(String(req.params.id)));
  });
  v2Router.post('/research/replay/:id/resume', (req, res) => {
    res.json(resumeReplay(String(req.params.id)));
  });
  v2Router.post('/research/replay/:id/stop', (req, res) => {
    res.json(stopReplay(String(req.params.id)));
  });
  v2Router.post('/research/replay/:id/step', (req, res) => {
    res.json(stepReplay(String(req.params.id)));
  });

  v2Router.get('/research/replay/:id', (req, res) => {
    const row = getReplayRun(String(req.params.id));
    if (!row) return res.status(404).json({ ok: false, error: 'REPLAY_NOT_FOUND' });
    // Loosely-typed by design (runs: Map<string, Record<string, unknown>> - real replay session
    // shape varies by run state) - matches the `as any` convention already used elsewhere in this
    // file for the same map (e.g. getReplayTrades below), not a new looseness introduced here.
    const { session, ...rest } = row as any;
    res.json({
      ok: true,
      ...rest,
      status: session?.status || rest.status,
      eventCount: rest.events?.length || session?.events?.length || 0,
      totalBars: session?.totalBars ?? null,
      currentBarIndex: session?.currentBarIndex ?? null,
      currentTimestamp: session?.currentTimestamp ?? null,
      live: 'NO-GO',
      executionEnvironment: 'REPLAY',
      organicPaper: false,
    });
  });

  v2Router.get('/research/replay/:id/events', (req, res) => {
    const row = getReplayRun(String(req.params.id));
    if (!row) return res.status(404).json({ ok: false, error: 'REPLAY_NOT_FOUND' });
    const events = row.events || (row as any).session?.events || [];
    res.json({ ok: true, events, live: 'NO-GO' });
  });

  v2Router.get('/research/replay/:id/trades', (req, res) => {
    const trades = getReplayTrades(String(req.params.id));
    if (trades == null) return res.status(404).json({ ok: false, error: 'REPLAY_NOT_FOUND' });
    res.json({ ok: true, trades, live: 'NO-GO', executionEnvironment: 'REPLAY', organicPaper: false });
  });

  v2Router.get('/research/replay/:id/portfolio', async (req, res) => {
    const { getReplayPortfolio } = await import('../replay/FullArgusReplayEngine');
    const portfolio = await getReplayPortfolio(String(req.params.id));
    if (portfolio == null) return res.status(404).json({ ok: false, error: 'REPLAY_NOT_FOUND' });
    res.json({ ok: true, portfolio, live: 'NO-GO', executionEnvironment: 'REPLAY' });
  });

  v2Router.get('/research/replay/:id/equity', (req, res) => {
    const equity = getReplayEquity(String(req.params.id));
    if (equity == null) return res.status(404).json({ ok: false, error: 'REPLAY_NOT_FOUND' });
    res.json({ ok: true, equity, live: 'NO-GO' });
  });

  v2Router.get('/research/replay/:id/report', (req, res) => {
    const row = getReplayRun(String(req.params.id));
    if (!row) return res.status(404).json({ ok: false, error: 'REPLAY_NOT_FOUND' });
    res.json({
      ok: true,
      report: row.report,
      promotion: row.promotion,
      hashes: row.hashes,
      agentAvailability: row.agentAvailability,
      live: 'NO-GO',
      notPaper: true,
      notLive: true,
    });
  });

  v2Router.get('/research/replay/:id/export', (req, res) => {
    const format = String(req.query.format || 'manifest').toLowerCase();
    const id = String(req.params.id);
    // Real bug fixed: id used to be joined straight into a filesystem path (replayStore.ts's
    // replayDir()) with zero sanitization - "../../../etc" style ids could list/read files
    // outside data/replays. Real replay ids are always crypto.randomUUID(); anything else is
    // rejected here with a clean 400 (replayDir() itself now also throws defense-in-depth).
    if (!isValidReplayId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid replay id (must be a UUID).' });
    }
    if (format === 'manifest') {
      return res.json({ ok: true, ...exportReplayManifest(id), live: 'NO-GO', format: 'manifest' });
    }
    if (format === 'json') {
      const art = readReplayArtifact(id, 'summary.json');
      if (!art) return res.status(404).json({ ok: false, error: 'EXPORT_UNAVAILABLE' });
      res.setHeader('Content-Type', art.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="replay-${id}-summary.json"`);
      return res.send(art.content);
    }
    if (format === 'jsonl') {
      const art = readReplayArtifact(id, 'events.jsonl');
      if (!art) return res.status(404).json({ ok: false, error: 'EXPORT_UNAVAILABLE' });
      res.setHeader('Content-Type', art.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="replay-${id}-events.jsonl"`);
      return res.send(art.content);
    }
    if (format === 'csv') {
      const kind = String(req.query.kind || 'trades');
      const csv = kind === 'equity' ? exportEquityCsv(id)
        : kind === 'rejections' ? exportRejectionsCsv(id)
        : kind === 'missed_opportunities' ? exportMissedOpportunitiesCsv(id)
        : exportTradesCsv(id);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="replay-${id}-${kind}.csv"`);
      return res.send(csv);
    }
    if (format === 'markdown') {
      const md = exportMarkdownReport(id);
      res.setHeader('Content-Type', 'text/markdown');
      res.setHeader('Content-Disposition', `attachment; filename="replay-${id}-report.md"`);
      return res.send(md);
    }
    if (format === 'zip') {
      const zip = exportZipArchive(id);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="replay-${id}-export.zip"`);
      return res.send(zip);
    }
    return res.status(400).json({ ok: false, error: 'Unsupported format. Use manifest|json|jsonl|csv|markdown|zip' });
  });

  // Argus Historical Evaluation — aliases over FullArgusReplayEngine (no duplicated trading logic).
  v2Router.post('/historical-evaluations', replayLabLimiter, async (req, res) => {
    try {
      assertNoArbitraryCode(req.body ?? {});
      const { createHistoricalEvaluation } = await import('../replay/HistoricalEvaluationService');
      const row = await createHistoricalEvaluation(req.body || {});
      if (!res.headersSent) res.json({ ok: true, ...row, canPlaceOrders: false });
    } catch (e: any) {
      if (!res.headersSent) res.status(400).json({ ok: false, error: e.message, canPlaceOrders: false, live: 'NO-GO' });
    }
  });

  v2Router.get('/historical-evaluations', async (_req, res) => {
    const { listReplayPackages } = await import('../replay/replayStore');
    const ids = listReplayPackages();
    res.json({ ok: true, evaluations: ids.map((id) => ({ replayId: id })), live: 'NO-GO' });
  });

  v2Router.get('/historical-evaluations/:id', (req, res) => {
    const { getHistoricalEvaluation } = require('../replay/HistoricalEvaluationService') as typeof import('../replay/HistoricalEvaluationService');
    const row = getHistoricalEvaluation(String(req.params.id));
    if (!row) return res.status(404).json({ ok: false, error: 'EVALUATION_NOT_FOUND' });
    res.json({ ok: true, ...row, live: 'NO-GO' });
  });

  v2Router.get('/historical-evaluations/:id/report', (req, res) => {
    const { getHistoricalEvaluationReport } = require('../replay/HistoricalEvaluationService') as typeof import('../replay/HistoricalEvaluationService');
    const report = getHistoricalEvaluationReport(String(req.params.id));
    if (!report) return res.status(404).json({ ok: false, error: 'EVALUATION_NOT_FOUND' });
    res.json({ ok: true, ...report, live: 'NO-GO' });
  });

  v2Router.get('/historical-evaluations/:id/export', (req, res) => {
    const format = String(req.query.format || 'zip').toLowerCase();
    const id = String(req.params.id);
    if (!isValidReplayId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid evaluation id (must be a UUID).' });
    }
    if (format === 'markdown') {
      const md = exportMarkdownReport(id);
      res.setHeader('Content-Type', 'text/markdown');
      res.setHeader('Content-Disposition', `attachment; filename="historical-evaluation-${id}-report.md"`);
      return res.send(md);
    }
    if (format === 'manifest') {
      return res.json({ ok: true, ...exportReplayManifest(id), live: 'NO-GO', format: 'manifest' });
    }
    const zip = exportZipArchive(id);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="historical-evaluation-${id}-export.zip"`);
    return res.send(zip);
  });
}
