import { Router } from 'express';
import { snapshotMetrics } from '../observability/ObservabilityMetrics';
import { getSessionId } from '../observability/ObservabilityContext';
import { observabilityConfig } from '../config/observability';
import { getDecisionTrace, getOrderTrace, exportDecisionTraceJson } from '../observability/queryTraces';
import { db } from '../db';
import { observabilityEvents } from '../db/schema';
import { desc, eq } from 'drizzle-orm';

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
    res.status(500).json({ ok: false, error: e.message });
  }
});

observabilityRouter.get('/decisions/:traceId', async (req, res) => {
  try {
    res.json(await getDecisionTrace(req.params.traceId));
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

observabilityRouter.get('/decisions/:traceId/export', async (req, res) => {
  try {
    const json = await exportDecisionTraceJson(req.params.traceId);
    res.setHeader('Content-Disposition', `attachment; filename="argus-decision-${req.params.traceId}.json"`);
    res.json(json);
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

observabilityRouter.get('/orders/:orderId', async (req, res) => {
  try {
    const result = await getOrderTrace(req.params.orderId);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
