import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { runtimeRouter } from './v2Runtime';

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
});
