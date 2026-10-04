import { describe, expect, it, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { runtimeRouter } from './v2Runtime';
import { argusApplication } from '../app/ArgusApplication';
import { structuredLogger } from '../observability/StructuredLogger';
import * as availability from '../core/aiQuantAvailability';
import { BrokerManager } from '../../brokers/BrokerManager';

describe('v2Runtime routes', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v2/runtime', runtimeRouter);
  });

  it('GET /runtime/status is registered', async () => {
    const res = await request(app).get('/api/v2/runtime/status');
    expect(res.status).toBeLessThan(500);
    expect(res.body).toHaveProperty('runtime');
  });

  it.each([false, true])('settles late health checks without a duplicate response (reject=%s)', async (reject) => {
    const res: any = { headersSent: false, destroyed: false, json: vi.fn(), status: vi.fn() };
    res.status.mockReturnValue(res);
    const broker = vi.spyOn(BrokerManager.getInstance(), 'getIbkrPathStatus').mockResolvedValue({} as any);
    const ai = vi.spyOn(availability, 'computeAiAvailability').mockResolvedValue({} as any);
    const quant = vi.spyOn(availability, 'computeQuantAvailability').mockImplementationOnce(async () => {
      res.headersSent = true;
      if (reject) throw new Error('late health failure');
      return {} as any;
    });
    try {
      const route: any = runtimeRouter.stack.find((layer: any) => layer.route?.path === '/health');
      const next = vi.fn();
      await route.route.stack[0].handle({}, res, next);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    } finally { broker.mockRestore(); ai.mockRestore(); quant.mockRestore(); }
  });

  it.each([false, true])('does not send a second orders response after timeout (ledger rejection=%s)', async (reject) => {
    const res: any = { headersSent: false, destroyed: false, setHeader: vi.fn(), once: vi.fn(), json: vi.fn(), status: vi.fn() };
    res.status.mockReturnValue(res);
    const read = vi.spyOn(argusApplication, 'recentTrades').mockImplementationOnce(async () => {
      res.headersSent = true; // server deadline already sent its 504 while the ledger was pending
      if (reject) throw new Error('late failure');
      return [];
    });
    try {
      const route = runtimeRouter.stack.find((layer: any) => layer.route?.path === '/orders') as any;
      await route.route.stack[0].handle({ query: {} }, res, vi.fn());
      expect(res.json).not.toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });

  it('traces orders latency and reports ledger failure without exposing exception details', async () => {
    const log = vi.spyOn(structuredLogger, 'info');
    const read = vi.spyOn(argusApplication, 'recentTrades').mockRejectedValueOnce(new Error('private database details'));
    try {
      const res = await request(app).get('/api/v2/runtime/orders');
      expect(res.status).toBe(503);
      expect(res.headers['x-request-id']).toBe(res.body.requestId);
      expect(JSON.stringify(res.body)).not.toContain('private database');
      expect(log).toHaveBeenCalledWith('runtime_orders_finished', expect.objectContaining({
        correlationId: res.body.requestId, statusCode: 503, durationMs: expect.any(Number), outcome: 'RESPONSE_FINISHED',
      }));
    } finally { read.mockRestore(); log.mockRestore(); }
  });

  it('GET /runtime/health is registered', async () => {
    const res = await request(app).get('/api/v2/runtime/health');
    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty('health');
    expect(res.body).toHaveProperty('activeBroker');
    expect(res.body.activeBroker).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      paperTradingOnly: expect.any(Boolean),
    });
  });

  // Zero-Trade Forensic Audit follow-up: process-alive must not read as decision-quality-healthy -
  // aiProviderHealth is a distinct summary sitting alongside `health`, never folded into it.
  it('GET /runtime/health includes an aiProviderHealth summary distinct from process health', async () => {
    const res = await request(app).get('/api/v2/runtime/health');
    expect(res.body).toHaveProperty('aiProviderHealth');
    if (res.body.aiProviderHealth) {
      expect(res.body.aiProviderHealth).toMatchObject({
        healthy: expect.any(Number),
        total: expect.any(Number),
        statuses: expect.any(Object),
      });
    }
  });

  it('GET /runtime/trading-readiness is registered and distinguishes process from trading-pipeline readiness', async () => {
    const res = await request(app).get('/api/v2/runtime/trading-readiness');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(typeof res.body.tradingReady).toBe('boolean');
    expect(res.body.nodes.map((n: any) => n.id)).toEqual(
      expect.arrayContaining(['process', 'database', 'marketData', 'broker', 'technicalEngine', 'quantEngine', 'aiProviderLayer']),
    );
  });

  it('GET /runtime/trading-readiness?format=text renders the ASCII tree', async () => {
    const res = await request(app).get('/api/v2/runtime/trading-readiness?format=text');
    expect(res.status).toBe(200);
    expect(res.text).toContain('ARGUS');
    expect(res.text).toContain('TRADING READY');
  });

  it('GET /runtime/ai/providers/health is registered and never exposes a raw key', async () => {
    const res = await request(app).get('/api/v2/runtime/ai/providers/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.providers)).toBe(true);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/api[_-]?key/i);
  });

  // 2026-09-21 operator-requested follow-up: a single blended "AI degraded -> trading degraded"
  // signal hides that QuantEngine/RiskEngine/OMS/Alpaca can be independently fine. This
  // disaggregates them - see the route's own header comment for what each status does and does
  // not measure.
  describe('GET /runtime/component-health', () => {
    it('returns all eight expected components with a real status for each', async () => {
      const res = await request(app).get('/api/v2/runtime/component-health');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      const names = res.body.components.map((c: any) => c.component);
      expect(names).toEqual([
        'Market Data', 'QuantEngine', 'RiskEngine', 'OMS', 'Alpaca Paper', 'AI Providers', 'Crypto Research', 'Crypto Execution',
      ]);
      for (const c of res.body.components) {
        expect(['HEALTHY', 'DEGRADED', 'UNAVAILABLE', 'NOT_ENABLED', 'UNKNOWN']).toContain(c.status);
        expect(typeof c.detail).toBe('string');
      }
    });

    it('Crypto Execution is always NOT_ENABLED - a deliberate architectural stop, never fabricated as available', async () => {
      const res = await request(app).get('/api/v2/runtime/component-health');
      const cryptoExecution = res.body.components.find((c: any) => c.component === 'Crypto Execution');
      expect(cryptoExecution.status).toBe('NOT_ENABLED');
    });

    it('QuantEngine status is derived independently of AI Providers status (does not collapse into one signal)', async () => {
      const res = await request(app).get('/api/v2/runtime/component-health');
      const quant = res.body.components.find((c: any) => c.component === 'QuantEngine');
      const ai = res.body.components.find((c: any) => c.component === 'AI Providers');
      // The two must be independently computed fields, not the same value duplicated under two labels.
      expect(quant.detail).not.toEqual(ai.detail);
      expect(quant.detail).toContain('independent of AI provider status');
    });

    it('?format=text renders a readable table with every component name', async () => {
      const res = await request(app).get('/api/v2/runtime/component-health?format=text');
      expect(res.status).toBe(200);
      expect(res.text).toContain('COMPONENT HEALTH');
      expect(res.text).toContain('Market Data');
      expect(res.text).toContain('Crypto Execution');
    });
  });
});
