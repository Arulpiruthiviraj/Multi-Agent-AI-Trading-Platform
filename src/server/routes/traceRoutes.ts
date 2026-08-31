/**
 * Consolidated distributed trace inspector — GET /api/v2/traces/:traceId
 * DB is source of truth (event_traces, transaction_traces, observability_events, risk, fills).
 */
import { Router } from 'express';
import { exportDecisionTraceJson, getDecisionTrace, getFullDecisionFunnelTrace, listRecentDecisionTraces } from '../observability/queryTraces';

export const traceRouter = Router();

traceRouter.get('/', async (req, res) => {
  try {
    const { symbol, status, limit } = req.query as { symbol?: string; status?: string; limit?: string };
    const capped = Math.min(parseInt(limit || '50', 10) || 50, 200);
    const traces = await listRecentDecisionTraces({ symbol, status, limit: capped });
    res.json({ ok: true, traces });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

traceRouter.get('/:traceId/export', async (req, res) => {
  try {
    const json = await exportDecisionTraceJson(req.params.traceId);
    res.setHeader('Content-Disposition', `attachment; filename="argus-decision-${req.params.traceId}.json"`);
    res.json(json);
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Phase 4A (Decision Funnel, 2026-08-26) - the full DISCOVERED -> TRADE_CLOSED trace, extending
 * getDecisionTrace with the pre-idea stages (DISCOVERED/RANKED/PROMOTED/SUBSCRIBED/DATA_READY)
 * reconstructed from existing event_traces rows. Read-only; no new instrumentation on the hot path.
 */
traceRouter.get('/:traceId/funnel', async (req, res) => {
  try {
    const assembled = await getFullDecisionFunnelTrace(req.params.traceId);
    res.json(assembled);
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

traceRouter.get('/:traceId', async (req, res) => {
  try {
    const { traceId } = req.params;
    const assembled = await getDecisionTrace(traceId);
    const firstMs = assembled.timeline[0] ? Date.parse(assembled.timeline[0].time) : Date.now();
    const lastMs = assembled.timeline.length > 0
      ? Date.parse(assembled.timeline[assembled.timeline.length - 1].time)
      : firstMs;
    res.json({
      ...assembled,
      totalLatencyMs: Math.max(0, lastMs - firstMs),
    });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});
