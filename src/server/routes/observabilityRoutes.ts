import { Router } from 'express';
import { snapshotMetrics } from '../observability/ObservabilityMetrics';
import { getSessionId } from '../observability/ObservabilityContext';
import { observabilityConfig } from '../config/observability';
import { getDecisionTrace, getOrderTrace, exportDecisionTraceJson } from '../observability/queryTraces';
import { db } from '../db';
import { observabilityEvents } from '../db/schema';
import { desc, eq } from 'drizzle-orm';
import { buildProviderHealthMatrix } from '../observability/providerHealthMatrix';
import { buildConsensusPipelineReport, formatConsensusPipelineReport } from '../observability/consensusPipelineReport';
import { buildTradingFunnelReport, formatTradingFunnelReport } from '../observability/tradingFunnelReport';
import { buildWhyNoTradeReport, formatWhyNoTradeReport } from '../observability/whyNoTradeReport';
import { buildCalibrationMaturityReport, formatCalibrationMaturityReport } from '../continuous/calibrationMaturity';
import { buildAgentEdgeDiscoveryReport, formatAgentEdgeDiscoveryReport } from '../observability/agentEdgeDiscoveryReport';
import { buildStrategyReadinessReport, formatStrategyReadinessReport } from '../research/strategyReadiness';
import { buildStrategyFairnessReport, formatStrategyFairnessReport } from '../research/strategySelectionReplay';
import { buildStrategyProfitabilityReport, formatStrategyProfitabilityReport } from '../research/strategyProfitabilityReport';
import { buildRescueOutcomeReport, formatRescueOutcomeReport } from '../observability/rescueOutcomeReport';
import { buildStrategyScorecard, formatStrategyScorecard } from '../research/strategyScorecard';
import { buildExplorationHealthReport, formatExplorationHealthReport } from '../observability/explorationHealthReport';
import { guardHeavyReport, HeavyReportRefusedError } from '../observability/heavyReportGuard';
import { buildRecertificationReview, formatRecertificationReview } from '../quant/strategies/StrategyRecertification';
import { buildStrategyScoreNormalizationComparison, formatStrategyScoreNormalizationComparison } from '../research/strategyScoreNormalizationComparison';
import { marketDataWorker } from '../services/MarketDataWorker';
import { buildAiCostGovernorReport, formatAiCostGovernorReport } from '../observability/aiCostGovernorReport';
import { buildDiscoveryLineageReport, formatDiscoveryLineageReport } from '../observability/discoveryLineageReport';
import { buildStrategyCatalog, formatStrategyCatalog } from '../research/strategyCatalog';
import { buildMultiHorizonSummaryReport, formatMultiHorizonSummaryReport } from '../research/multiHorizonOutcomeReport';
import { buildConsensusDebateHealthReport, formatConsensusDebateHealthReport } from '../research/consensusDebateHealthReport';
import { buildOpportunitySnapshot, formatOpportunitySnapshot } from '../research/opportunitySnapshot';
import { buildExecutionQualityReport, summarizeExecutionQuality, formatExecutionQualityReport } from '../research/executionQuality';
import { buildForecast, mostRecentForecast, PRIMARY_EVAL_HORIZON_LABEL } from '../research/forecastEngine';
import { buildDailyAttributionReport, summarizeDailyAttribution, formatDailyAttributionReport } from '../research/dailyAttributionReport';
import { buildMarketDataDiagnosticsReport, formatMarketDataDiagnosticsReport } from '../observability/marketDataDiagnosticsReport';

export const observabilityRouter = Router();

observabilityRouter.get('/metrics', (_req, res) => {
  res.json({
    ok: true,
    sessionId: getSessionId(),
    live: 'NO-GO',
    counters: snapshotMetrics(),
    config: {
      persistMinLevel: observabilityConfig.persistMinLevel,
      retentionDays: observabilityConfig.retentionDays,
      marketDataSampleEveryN: observabilityConfig.marketDataSampleEveryN,
      maxQueueSize: observabilityConfig.maxQueueSize,
    },
  });
});

observabilityRouter.get('/events', async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit || '100'), 10) || 100, 500);
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const rows = category
      ? await db.select().from(observabilityEvents).where(eq(observabilityEvents.category, category)).orderBy(desc(observabilityEvents.ts)).limit(limit)
      : await db.select().from(observabilityEvents).orderBy(desc(observabilityEvents.ts)).limit(limit);
    res.json({ ok: true, events: rows });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

observabilityRouter.get('/decisions/:traceId', async (req, res) => {
  try {
    res.json(await getDecisionTrace(req.params.traceId));
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

observabilityRouter.get('/decisions/:traceId/export', async (req, res) => {
  try {
    const json = await exportDecisionTraceJson(req.params.traceId);
    res.setHeader('Content-Disposition', `attachment; filename="argus-decision-${req.params.traceId}.json"`);
    res.json(json);
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// Phase 9 (2026-08-27): real, queryable per-provider health - never a new live probe, only DB
// aggregates + AIRouter's in-memory routing snapshot. See providerHealthMatrix.ts's header.
observabilityRouter.get('/provider-health-matrix', async (req, res) => {
  try {
    const windowHours = Math.min(parseFloat(String(req.query.windowHours || '6')) || 6, 168);
    const matrix = await buildProviderHealthMatrix(new Date(), windowHours * 60 * 60 * 1000);
    res.json({ ok: true, windowHours, providers: matrix });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// Phase 9 (2026-08-27): the aggregated "why no trade" dashboard - built from real
// CONSENSUS_TERMINAL_REASON rows (see consensusPipelineReport.ts's header for why the generic
// EventBus->observability bridge could not be reused) plus risk_assessments/trades/fills.
observabilityRouter.get('/consensus-report', async (req, res) => {
  try {
    const hours = Math.min(parseFloat(String(req.query.hours || '24')) || 24, 24 * 30);
    const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const report = await buildConsensusPipelineReport(sinceIso);
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatConsensusPipelineReport(report));
      return;
    }
    res.json({ ok: true, report });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// 2026-09-13 (ConsensusDebate P0.5 forensic measurement, argus-cli consensus-debate-health) -
// real HOLD-veto good/bad classification + net economic value of ConsensusDebate's vetoes.
// OBSERVATION ONLY - never changes production behavior. Optional ?hours= windows the report;
// omit for all-time (the table starts empty as of 2026-09-13, so all-time is usually what's wanted
// until real sample size accumulates).
observabilityRouter.get('/consensus-debate-health', async (req, res) => {
  try {
    const hoursParam = req.query.hours;
    const sinceIso = typeof hoursParam === 'string'
      ? new Date(Date.now() - Math.min(parseFloat(hoursParam) || 720, 24 * 365) * 60 * 60 * 1000).toISOString()
      : undefined;
    const report = await buildConsensusDebateHealthReport(sinceIso);
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatConsensusDebateHealthReport(report));
      return;
    }
    res.json({ ok: true, report });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// 2026-09-13 (Institutional Transformation Mandate, Part 8/9 - argus-cli opportunity-snapshot).
// Pure composition of five already-real reports (recent QuantEngine ideas, real historical edge,
// real multi-horizon forward returns, real strategy catalog metadata, real held-positions check) -
// ranked by real evidence quality, never a fabricated expected-return score. See
// opportunitySnapshot.ts's own header for the full rationale.
observabilityRouter.get('/opportunity-snapshot', async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit || '20'), 10) || 20, 100);
    const rows = await buildOpportunitySnapshot(limit);
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatOpportunitySnapshot(rows));
      return;
    }
    res.json({ ok: true, rows });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// 2026-09-13 (Institutional Transformation Mandate Part 16, argus-cli execution-quality) - real
// slippage: trades.arrival_price (written once at order insert, never overwritten) vs the real
// matching fills row(s). Answers Part 32's own Q18 ("is execution destroying alpha") with real
// evidence instead of leaving it permanently unanswerable. See executionQuality.ts's own header.
observabilityRouter.get('/execution-quality', async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit || '500'), 10) || 500, 2000);
    const rows = await buildExecutionQualityReport(limit);
    const summary = summarizeExecutionQuality(rows);
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatExecutionQualityReport(rows, summary));
      return;
    }
    res.json({ ok: true, summary, rows });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// 2026-09-13 (Institutional Transformation Mandate Part 7, argus-cli forecast) - computes and
// persists one real, immutable forecast (forecastEngine.ts) from Argus's own already-graded
// historical outcomes via the authoritative Java statistical engine. POST because this has a real
// side effect (a new quant_forecasts row + a real Java call) - not a passive read. Body:
// {agentName, symbol, direction, strategyId?, horizonLabel?, regime?}.
observabilityRouter.post('/forecast', async (req, res) => {
  try {
    const { agentName, symbol, direction, strategyId, horizonLabel, regime } = req.body ?? {};
    if (typeof agentName !== 'string' || typeof symbol !== 'string' || (direction !== 'BUY' && direction !== 'SELL')) {
      res.status(400).json({ ok: false, error: 'agentName (string), symbol (string), and direction ("BUY"|"SELL") are required' });
      return;
    }
    const forecast = await buildForecast({
      agentName, symbol, direction,
      strategyId: typeof strategyId === 'string' ? strategyId : null,
      horizonLabel: typeof horizonLabel === 'string' ? horizonLabel : undefined,
      regime: typeof regime === 'string' ? regime : null,
    });
    res.json({ ok: true, forecast });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// Real, already-persisted forecast for a symbol - read-only, no live Java call (mandate item 24's
// "safe, bounded" integration point for other read models such as opportunitySnapshot.ts).
observabilityRouter.get('/forecast', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '');
    const agentName = String(req.query.agentName || '');
    const direction = req.query.direction === 'SELL' ? 'SELL' : 'BUY';
    const strategyId = typeof req.query.strategyId === 'string' ? req.query.strategyId : null;
    const horizonLabel = typeof req.query.horizonLabel === 'string' ? req.query.horizonLabel : PRIMARY_EVAL_HORIZON_LABEL;
    if (!symbol || !agentName) {
      res.status(400).json({ ok: false, error: 'symbol and agentName query params are required' });
      return;
    }
    const forecast = await mostRecentForecast(symbol, agentName, strategyId, direction, horizonLabel);
    res.json({ ok: true, forecast });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// 2026-09-14 (Institutional Transformation Mandate Part 21, argus-cli daily-attribution) - real
// realized P&L by real NY trading date + real strategy id, from organic PAPER FILLED SELL trades
// only (never blended with REPLAY/BACKTEST/SIMULATION/LIVE) - see dailyAttributionReport.ts's own
// header for why this composes trades.* directly rather than the campaign-only
// daily_strategy_performance table. Optional ?sinceDate=YYYY-MM-DD (NY trading-date string).
observabilityRouter.get('/daily-attribution', async (req, res) => {
  try {
    const sinceDate = typeof req.query.sinceDate === 'string' ? req.query.sinceDate : undefined;
    const rows = await buildDailyAttributionReport(sinceDate);
    const summary = summarizeDailyAttribution(rows);
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatDailyAttributionReport(rows, summary));
      return;
    }
    res.json({ ok: true, summary, rows });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// Phase 9 (2026-08-31): the single authoritative trading-funnel dashboard (argus-cli trading-funnel)
// - composes candidateLifecycle counts + consensusPipelineReport + providerHealthMatrix, no new data path.
observabilityRouter.get('/trading-funnel', async (req, res) => {
  try {
    const hours = Math.min(parseFloat(String(req.query.hours || '24')) || 24, 24 * 30);
    const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const report = await buildTradingFunnelReport(sinceIso);
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatTradingFunnelReport(report));
      return;
    }
    res.json({ ok: true, report });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// Phase 9 (2026-08-31): single-candidate "why did this not trade" explainer (argus-cli why-no-trade).
observabilityRouter.get('/why-no-trade', async (req, res) => {
  try {
    const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : undefined;
    const report = await buildWhyNoTradeReport(symbol);
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatWhyNoTradeReport(report));
      return;
    }
    res.json({ ok: true, report });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// Phase 9 (2026-08-31): explicit calibration maturity classification (Phase 6 "safe maturity
// model") - UNVALIDATED/LEARNING/CALIBRATED/TRUSTED per (agent, bucket), reusing only already-
// computed effective-N/Wilson-lower-bound data. Read-only, never gates a trade.
observabilityRouter.get('/calibration-maturity', async (req, res) => {
  try {
    const rows = await buildCalibrationMaturityReport();
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatCalibrationMaturityReport(rows));
      return;
    }
    res.json({ ok: true, rows });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// Phase 10 (2026-08-31): Agent Edge Discovery & Strategy Validation - the decision-ready
// agent-edge / strategy-edge / agent-combination / trading-eligibility report (argus-cli agent-edge).
observabilityRouter.get('/agent-edge', async (req, res) => {
  try {
    const report = await guardHeavyReport('agent-edge', buildAgentEdgeDiscoveryReport);
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatAgentEdgeDiscoveryReport(report));
      return;
    }
    res.json({ ok: true, report });
  } catch (e: any) {
    if (res.headersSent) return;
    if (e instanceof HeavyReportRefusedError) {
      res.status(429).json({ ok: false, refused: true, code: e.code, error: e.message });
      return;
    }
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Phase 10 continuation (2026-08-31): strategy activation matrix + real per-strategy edge status
// (argus-cli strategy-readiness) - which of the 5 CORE quant strategies are implemented/enabled/
// reachable, and what real evidence exists for each (EV-backed vs. cold-start-bootstrap-sourced,
// never merged).
observabilityRouter.get('/strategy-readiness', async (req, res) => {
  try {
    const rows = await buildStrategyReadinessReport();
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatStrategyReadinessReport(rows));
      return;
    }
    res.json({ ok: true, rows });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// 2026-09-11: strategy metadata catalog (argus-cli strategy-catalog) - every strategy id this
// codebase currently knows about (CORE + EXPERIMENTAL TS + JAVA_RESEARCH), its family, whether
// it's live-eligible right now, Node/Java ownership where known, and lifecycle status. Purely
// structural - no win-rate/N/return numbers (strategy-readiness/strategy-scorecard own that).
observabilityRouter.get('/strategy-catalog', async (req, res) => {
  try {
    const rows = await buildStrategyCatalog();
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatStrategyCatalog(rows));
      return;
    }
    res.json({ ok: true, rows });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// 2026-09-12 (Research Memory Platform Phase 2, argus-cli multi-horizon-outcomes) - real
// aggregate over prediction_outcome_horizons (MultiHorizonOutcomeEvaluator.ts): mean forward
// return / positive-return rate per (agent, strategy, horizon). Purely additive research
// telemetry - never read by weight learning, RiskEngine, or consensus.
observabilityRouter.get('/multi-horizon-outcomes', async (req, res) => {
  try {
    const agentName = typeof req.query.agentName === 'string' ? req.query.agentName : undefined;
    const rows = await buildMultiHorizonSummaryReport(agentName);
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatMultiHorizonSummaryReport(rows));
      return;
    }
    res.json({ ok: true, rows });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// Phase 12 (2026-08-31): strategy-fairness report - replays the REAL production selection code
// (rankEvaluationsForRegime/selectEvaluationsForAdaptiveRegime/bestStrategyIdea) against real
// historical quant_assessments rows, cross-referenced with real agent_predictions ground truth, to
// distinguish "evaluated but never selected" from "selected but never emitted" from "emitted but
// never graded" (argus-cli strategy-fairness). Can take several seconds - real, non-trivial
// computation over potentially tens of thousands of real rows, not a hang.
observabilityRouter.get('/strategy-fairness', async (req, res) => {
  try {
    const rows = await guardHeavyReport('strategy-fairness', buildStrategyFairnessReport);
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatStrategyFairnessReport(rows));
      return;
    }
    res.json({ ok: true, rows });
  } catch (e: any) {
    if (res.headersSent) return;
    if (e instanceof HeavyReportRefusedError) {
      res.status(429).json({ ok: false, refused: true, code: e.code, error: e.message });
      return;
    }
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Phase 13 (2026-08-31 real-edge audit): real net-P&L trading-profitability per strategy, using
// real fill prices from getRealClosedRoundTrips() - never estimated. Deliberately separate from
// strategy-fairness/strategy-readiness (predictive-selection questions) - this answers "would
// trading this strategy have made money," not "did its direction call turn out correct."
observabilityRouter.get('/strategy-profitability', async (req, res) => {
  try {
    const costProfile = typeof req.query.costProfile === 'string' ? req.query.costProfile : undefined;
    const rows = await buildStrategyProfitabilityReport(costProfile);
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatStrategyProfitabilityReport(rows));
      return;
    }
    res.json({ ok: true, rows });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// Phase 14 (2026-08-31): did a temporary market-data rescue grant (MarketDataWorker.
// requestTemporaryDataRescue) actually lead to consensus/RiskEngine/a paper fill? Read-only
// correlation over already-persisted rows - never a new decision path.
observabilityRouter.get('/rescue-outcomes', async (req, res) => {
  try {
    const hours = Math.min(parseFloat(String(req.query.hours || '24')) || 24, 24 * 30);
    const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const rows = await buildRescueOutcomeReport(sinceIso);
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatRescueOutcomeReport(rows));
      return;
    }
    res.json({ ok: true, rows });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// Phase 14 (2026-08-31): complete 21-strategy scorecard combining strategy-fairness,
// strategy-profitability, and lifecycle status (real data, always available). Replay-derived
// walk-forward verdicts are NOT run automatically here (running replay is a real, potentially
// long-running operation this read-only report must never trigger) - it reports organic-only
// classifications unless replay verdicts are supplied out of band.
observabilityRouter.get('/strategy-scorecard', async (req, res) => {
  try {
    const rows = await guardHeavyReport('strategy-scorecard', () => buildStrategyScorecard([]));
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatStrategyScorecard(rows));
      return;
    }
    res.json({ ok: true, rows });
  } catch (e: any) {
    if (res.headersSent) return;
    if (e instanceof HeavyReportRefusedError) {
      res.status(429).json({ ok: false, refused: true, code: e.code, error: e.message });
      return;
    }
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Strategy lifecycle re-certification review (2026-09-14, item #9 / mandate Phase 11). Review
// only - never auto-reinstates a RETIRED/DEGRADED strategy (see StrategyRecertification.ts's own
// header). argus-cli strategy-recertification.
observabilityRouter.get('/strategy-recertification', async (req, res) => {
  try {
    const rows = await guardHeavyReport('strategy-recertification', buildRecertificationReview);
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatRecertificationReview(rows));
      return;
    }
    res.json({ ok: true, rows });
  } catch (e: any) {
    if (res.headersSent) return;
    if (e instanceof HeavyReportRefusedError) {
      res.status(429).json({ ok: false, refused: true, code: e.code, error: e.message });
      return;
    }
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Raw-vs-normalized strategy score comparison (2026-09-14, item #7 / mandate Phase 10). Read-only
// research signal - never flips quantThresholds.strategyScoreNormalizationEnabled itself. See
// strategyScoreNormalizationComparison.ts's own header for the method and its honest limitations.
observabilityRouter.get('/strategy-score-normalization-comparison', async (req, res) => {
  try {
    const report = await guardHeavyReport('strategy-score-normalization-comparison', buildStrategyScoreNormalizationComparison);
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatStrategyScoreNormalizationComparison(report));
      return;
    }
    res.json({ ok: true, report });
  } catch (e: any) {
    if (res.headersSent) return;
    if (e instanceof HeavyReportRefusedError) {
      res.status(429).json({ ok: false, refused: true, code: e.code, error: e.message });
      return;
    }
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Phase 18 (2026-09-01 rescue-fairness + exploration-observability mission), Part 5/6/10: joins
// STRATEGY_EXPLORATION_PROMOTED to rescue grant/denial, idea discard/emission, consensus, RiskEngine,
// and OMS/fill outcomes by shared traceId, producing a Level 0-6 success ladder per promotion. Read-only.
observabilityRouter.get('/exploration-health', async (req, res) => {
  try {
    const hours = Math.min(parseFloat(String(req.query.hours || '24')) || 24, 24 * 30);
    const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const report = await buildExplorationHealthReport(sinceIso);
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatExplorationHealthReport(report));
      return;
    }
    res.json({ ok: true, ...report });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// Phase 18, Part 7: current temporary-data-rescue occupants (who holds a rescue slot right now,
// what class, since when, how many times renewed) - read-only introspection of live in-memory
// admission state, no secrets/credentials/account data.
observabilityRouter.get('/rescue-occupants', async (req, res) => {
  try {
    const occupants = marketDataWorker.getActiveTemporaryRescues();
    if (req.query.format === 'text') {
      const lines = ['RESCUE OCCUPANTS (current temporary-data-rescue slot holders)', '-----------------------------------------------------------'];
      if (occupants.length === 0) {
        lines.push('(no active rescues)');
      } else {
        lines.push('Symbol'.padEnd(10) + 'Class'.padEnd(18) + 'GrantedAt'.padEnd(26) + 'ExpiresAt'.padEnd(26) + 'Requests'.padEnd(10) + 'Extensions'.padEnd(12) + 'TraceId');
        for (const o of occupants) {
          lines.push(
            String(o.symbol).padEnd(10)
            + String(o.requestClass).padEnd(18)
            + new Date(o.grantedAtMs).toISOString().padEnd(26)
            + new Date(o.expiresAtMs).toISOString().padEnd(26)
            + String(o.requestCount).padEnd(10)
            + String(o.extensionCount).padEnd(12)
            + String(o.traceId ?? '-'),
          );
        }
      }
      res.type('text/plain').send(lines.join('\n'));
      return;
    }
    res.json({ ok: true, occupants });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// Phase A2/A5/M (AI Cost Governor, 2026-09-02): current policy, the per-(agent,provider) real
// graded-outcome quality ledger, and recent shadow-mode decisions. Read-only; the governor itself
// is off by default (config/aiCostGovernor.json) and never gates a trade.
observabilityRouter.get('/ai-cost-governor', async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const report = await buildAiCostGovernorReport(limit);
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatAiCostGovernorReport(report));
      return;
    }
    res.json({ ok: true, ...report });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// Phase A (Discovery Lineage Ledger, 2026-09-02 forensic audit follow-up): per-symbol admit/filter
// decision from MarketUniverseScanner's real liquidity screen, plus how far that symbol got through
// subscription/evaluation/consensus/risk/OMS. Discovery-stage data only exists for activity after
// this phase shipped - it cannot retroactively explain an earlier miss, only future ones.
observabilityRouter.get('/discovery-lineage', async (req, res) => {
  try {
    const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : '';
    if (!symbol) {
      res.status(400).json({ ok: false, error: 'symbol query parameter is required' });
      return;
    }
    const hours = Math.min(parseFloat(String(req.query.hours || '24')) || 24, 24 * 30);
    const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const report = await buildDiscoveryLineageReport(symbol, sinceIso);
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatDiscoveryLineageReport(report));
      return;
    }
    res.json({ ok: true, ...report });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// 2026-09-20 (delayed-data observability follow-up, argus-cli market-data-diagnostics): read-only
// live in-memory market-data diagnostics - same "no new tracking, just read what already exists"
// pattern as /rescue-occupants above. Purposely NOT per-tick logging (would be noisy/expensive per
// the operator's own explicit preference) - this is a pull-based snapshot instead. Optional
// ?symbols=AAPL,MSFT filters to specific symbols; omit for every currently-allocated symbol.
observabilityRouter.get('/market-data-diagnostics', (req, res) => {
  try {
    const symbolsParam = typeof req.query.symbols === 'string' ? req.query.symbols : undefined;
    const symbols = symbolsParam ? symbolsParam.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const report = buildMarketDataDiagnosticsReport(symbols);
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatMarketDataDiagnosticsReport(report));
      return;
    }
    res.json({ ok: true, ...report });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

observabilityRouter.get('/orders/:orderId', async (req, res) => {
  try {
    const result = await getOrderTrace(req.params.orderId);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});
