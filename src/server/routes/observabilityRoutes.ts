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

observabilityRouter.get('/orders/:orderId', async (req, res) => {
  try {
    const result = await getOrderTrace(req.params.orderId);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});
