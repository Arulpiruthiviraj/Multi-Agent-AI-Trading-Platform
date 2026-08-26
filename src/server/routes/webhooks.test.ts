import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { webhooksRouter } from './webhooks';

describe('webhooksRouter - SSRF guard on write/test routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/webhooks', webhooksRouter);

  it('rejects creating a webhook pointed at a private/internal address', async () => {
    const res = await request(app).post('/api/v1/webhooks').send({
      name: 'evil', url: 'http://169.254.169.254/latest/meta-data/', type: 'generic',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Unsafe webhook URL');
  });

  it('rejects updating a webhook to a private/internal address', async () => {
    const created = await request(app).post('/api/v1/webhooks').send({
      name: 'real', url: 'https://hooks.slack.com/services/T00/B00/REAL', type: 'slack',
    });
    expect(created.status).toBe(200);
    const res = await request(app).put(`/api/v1/webhooks/${created.body.id}`).send({ url: 'http://127.0.0.1:6379/' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Unsafe webhook URL');
  });

  it('rejects testing a private/internal address', async () => {
    const res = await request(app).post('/api/v1/webhooks/test').send({ url: 'http://10.0.0.1/', type: 'generic' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Unsafe webhook URL');
  });
});

// Real defect fixed (2026-08-26 comprehensive remediation pass): `url` on POST /test is an
// arbitrary caller-supplied endpoint with NO timeout of its own - a slow/hanging destination
// could run past server.ts's global 15s per-request backstop, which sends its own response
// first, then this handler's late resolution would try to send a second one, throwing
// ERR_HTTP_HEADERS_SENT (the same root cause already fixed twice in v2System.ts this session).
describe('webhooksRouter POST /test (fetch timeout + double-response guard)', { timeout: 30000 }, () => {
  const originalFetch = global.fetch;

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('does not hang forever when the destination never responds - bounded by the fallback timeout', async () => {
    global.fetch = (() => new Promise(() => { /* never resolves */ })) as typeof fetch;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/webhooks', webhooksRouter);

    const startedAt = Date.now();
    const res = await request(app).post('/api/v1/webhooks/test').send({ url: 'https://hooks.slack.com/services/REAL', type: 'slack' });
    const elapsedMs = Date.now() - startedAt;

    expect(res.status).toBe(500);
    expect(elapsedMs).toBeLessThan(10000);
  });

  it('does not throw ERR_HTTP_HEADERS_SENT when a response was already sent before fetch() rejects', async () => {
    global.fetch = (() => new Promise(() => { /* never resolves */ })) as typeof fetch;
    const racedApp = express();
    racedApp.use(express.json());
    racedApp.use('/api/v1/webhooks/test', (req, res, next) => {
      res.status(504).json({ error: 'Request Timeout (simulated backstop)' });
      next();
    });
    racedApp.use('/api/v1/webhooks', webhooksRouter);

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      await request(racedApp).post('/api/v1/webhooks/test').send({ url: 'https://hooks.slack.com/services/REAL', type: 'slack' });
      await new Promise((r) => setTimeout(r, 6500));
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }

    const headersSentErrors = unhandledRejections.filter(
      (e) => e instanceof Error && e.message.includes('ERR_HTTP_HEADERS_SENT'),
    );
    expect(headersSentErrors).toEqual([]);
  }, 15000);

  it('success path is unaffected: a real response resolves in a single 200', async () => {
    global.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/webhooks', webhooksRouter);

    const res = await request(app).post('/api/v1/webhooks/test').send({ url: 'https://hooks.slack.com/services/REAL', type: 'slack' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
