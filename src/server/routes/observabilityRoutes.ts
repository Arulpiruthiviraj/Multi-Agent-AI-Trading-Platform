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
import { marketDataWorker } from '../services/MarketDataWorker';
import { buildAiCostGovernorReport, formatAiCostGovernorReport } from '../observability/aiCostGovernorReport';

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
    const report = await buildAgentEdgeDiscoveryReport();
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatAgentEdgeDiscoveryReport(report));
      return;
    }
    res.json({ ok: true, report });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
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

// Phase 12 (2026-08-31): strategy-fairness report - replays the REAL production selection code
// (rankEvaluationsForRegime/selectEvaluationsForAdaptiveRegime/bestStrategyIdea) against real
// historical quant_assessments rows, cross-referenced with real agent_predictions ground truth, to
// distinguish "evaluated but never selected" from "selected but never emitted" from "emitted but
// never graded" (argus-cli strategy-fairness). Can take several seconds - real, non-trivial
// computation over potentially tens of thousands of real rows, not a hang.
observabilityRouter.get('/strategy-fairness', async (req, res) => {
  try {
    const rows = await buildStrategyFairnessReport();
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatStrategyFairnessReport(rows));
      return;
    }
    res.json({ ok: true, rows });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
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
    const rows = await buildStrategyScorecard([]);
    if (req.query.format === 'text') {
      res.type('text/plain').send(formatStrategyScorecard(rows));
      return;
    }
    res.json({ ok: true, rows });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
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

observabilityRouter.get('/orders/:orderId', async (req, res) => {
  try {
    const result = await getOrderTrace(req.params.orderId);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});
