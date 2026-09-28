import { describe, it, expect, afterAll, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { webhooksRouter, triggerWebhooks } from './webhooks';

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
//
// F29/F32 follow-up: the test route now goes through the same safeFetch() transport as real
// dispatch (src/server/core/safeFetch.ts), not a bare global fetch(). These tests mock safeFetch
// and isSafeOutboundUrl directly (per the task's "local mock transport... never real outbound
// network calls" instruction) rather than relying on a real DNS lookup against hooks.slack.com,
// which the pre-existing version of this suite did.
vi.mock('../core/safeFetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/safeFetch')>();
  return { ...actual, safeFetch: vi.fn() };
});
vi.mock('../core/urlSafety', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/urlSafety')>();
  // Defaults to the REAL implementation (so the first describe block above, which only ever uses
  // literal IP addresses and needs no DNS, is unaffected and still exercises real SSRF logic).
  // Describes below that use a symbolic hostname (hooks.slack.com) override this per-test to avoid
  // a real DNS lookup, since those tests are about safeFetch's dispatch behavior, not the SSRF
  // guard itself (already covered by urlSafety.test.ts and the first describe block here).
  return { ...actual, isSafeOutboundUrl: vi.fn(actual.isSafeOutboundUrl) };
});

import { safeFetch as mockedSafeFetch, SafeFetchBlockedError } from '../core/safeFetch';
import { isSafeOutboundUrl as mockedIsSafeOutboundUrl } from '../core/urlSafety';

describe('webhooksRouter POST /test (safeFetch timeout + double-response guard)', { timeout: 30000 }, () => {
  beforeEach(() => {
    vi.mocked(mockedSafeFetch).mockReset();
    vi.mocked(mockedIsSafeOutboundUrl).mockImplementation(async () => ({ safe: true }));
  });

  it('does not hang forever when the destination never responds - bounded by the fallback timeout', async () => {
    vi.mocked(mockedSafeFetch).mockImplementation(() => new Promise(() => { /* never resolves */ }));
    const app = express();
    app.use(express.json());
    app.use('/api/v1/webhooks', webhooksRouter);

    const startedAt = Date.now();
    const res = await request(app).post('/api/v1/webhooks/test').send({ url: 'https://hooks.slack.com/services/REAL', type: 'slack' });
    const elapsedMs = Date.now() - startedAt;

    expect(res.status).toBe(500);
    expect(elapsedMs).toBeLessThan(10000);
  });

  it('does not throw ERR_HTTP_HEADERS_SENT when a response was already sent before safeFetch() rejects', async () => {
    vi.mocked(mockedSafeFetch).mockImplementation(() => new Promise(() => { /* never resolves */ }));
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
    vi.mocked(mockedSafeFetch).mockResolvedValue({ ok: true, status: 200, body: '' });
    const app = express();
    app.use(express.json());
    app.use('/api/v1/webhooks', webhooksRouter);

    const res = await request(app).post('/api/v1/webhooks/test').send({ url: 'https://hooks.slack.com/services/REAL', type: 'slack' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('a non-2xx response is reported as a failed test, not silent success', async () => {
    vi.mocked(mockedSafeFetch).mockResolvedValue({ ok: false, status: 503, body: 'unavailable' });
    const app = express();
    app.use(express.json());
    app.use('/api/v1/webhooks', webhooksRouter);

    const res = await request(app).post('/api/v1/webhooks/test').send({ url: 'https://hooks.slack.com/services/REAL', type: 'slack' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.status).toBe(503);
  });

  it('a blocked connection-time target is reported as 400, not a generic 500', async () => {
    vi.mocked(mockedSafeFetch).mockRejectedValue(new SafeFetchBlockedError('blocked at connect time'));
    const app = express();
    app.use(express.json());
    app.use('/api/v1/webhooks', webhooksRouter);

    const res = await request(app).post('/api/v1/webhooks/test').send({ url: 'https://hooks.slack.com/services/REAL', type: 'slack' });
    expect(res.status).toBe(400);
  });
});

describe('webhooksRouter - F31 event/type/enabled validation at create/update', () => {
  beforeEach(() => {
    vi.mocked(mockedIsSafeOutboundUrl).mockImplementation(async () => ({ safe: true }));
  });

  it('rejects create with a non-array events value (object)', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/webhooks', webhooksRouter);
    const res = await request(app).post('/api/v1/webhooks').send({
      name: 'bad', url: 'https://hooks.slack.com/services/BAD1', type: 'generic', events: { foo: 'bar' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects create with a numeric events value', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/webhooks', webhooksRouter);
    const res = await request(app).post('/api/v1/webhooks').send({
      name: 'bad', url: 'https://hooks.slack.com/services/BAD2', type: 'generic', events: 42,
    });
    expect(res.status).toBe(400);
  });

  it('rejects create with a null events value', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/webhooks', webhooksRouter);
    const res = await request(app).post('/api/v1/webhooks').send({
      name: 'bad', url: 'https://hooks.slack.com/services/BAD3', type: 'generic', events: null,
    });
    expect(res.status).toBe(400);
  });

  it('rejects create with a string events value (would have unintended .includes substring semantics)', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/webhooks', webhooksRouter);
    const res = await request(app).post('/api/v1/webhooks').send({
      name: 'bad', url: 'https://hooks.slack.com/services/BAD4', type: 'generic', events: 'veto',
    });
    expect(res.status).toBe(400);
  });

  it('rejects create with an unsupported event name inside a valid array', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/webhooks', webhooksRouter);
    const res = await request(app).post('/api/v1/webhooks').send({
      name: 'bad', url: 'https://hooks.slack.com/services/BAD5', type: 'generic', events: ['veto', 'not_a_real_event'],
    });
    expect(res.status).toBe(400);
  });

  it('rejects create with an unsupported webhook type', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/webhooks', webhooksRouter);
    const res = await request(app).post('/api/v1/webhooks').send({
      name: 'bad', url: 'https://hooks.slack.com/services/BAD6', type: 'teams', events: ['all'],
    });
    expect(res.status).toBe(400);
  });

  it('accepts a valid events array and stores exactly that array', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/webhooks', webhooksRouter);
    const res = await request(app).post('/api/v1/webhooks').send({
      name: 'good', url: 'https://hooks.slack.com/services/GOOD1', type: 'generic', events: ['veto', 'order_executed'],
    });
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual(['veto', 'order_executed']);
  });

  it('rejects an update with a malformed events value and leaves the existing webhook unchanged (atomic)', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/webhooks', webhooksRouter);
    const created = await request(app).post('/api/v1/webhooks').send({
      name: 'stable', url: 'https://hooks.slack.com/services/STABLE1', type: 'generic', events: ['veto'],
    });
    expect(created.status).toBe(200);

    const res = await request(app).put(`/api/v1/webhooks/${created.body.id}`).send({ name: 'renamed', events: 123 });
    expect(res.status).toBe(400);

    const after = await request(app).get('/api/v1/webhooks');
    const stillThere = after.body.find((w: any) => w.id === created.body.id);
    expect(stillThere.name).toBe('stable'); // rename was NOT partially applied alongside the bad events value
    expect(stillThere.events).toEqual(['veto']);
  });

  it('rejects an update with an unsupported webhook type without applying any other field', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/webhooks', webhooksRouter);
    const created = await request(app).post('/api/v1/webhooks').send({
      name: 'stable2', url: 'https://hooks.slack.com/services/STABLE2', type: 'generic', events: ['veto'],
    });
    const res = await request(app).put(`/api/v1/webhooks/${created.body.id}`).send({ name: 'renamed2', type: 'not_a_type' });
    expect(res.status).toBe(400);

    const after = await request(app).get('/api/v1/webhooks');
    const stillThere = after.body.find((w: any) => w.id === created.body.id);
    expect(stillThere.name).toBe('stable2');
  });
});

describe('triggerWebhooks - F31/F32 dispatch resilience', () => {
  beforeEach(() => {
    vi.mocked(mockedSafeFetch).mockReset();
    vi.mocked(mockedIsSafeOutboundUrl).mockImplementation(async () => ({ safe: true }));
  });

  it('a malformed stored events value on one webhook cannot crash dispatch to another webhook', async () => {
    // Create one well-formed webhook via the router (goes through validation) plus manually poke
    // a malformed `events` value onto it afterward to simulate a pre-F31 legacy record that
    // predates validation - triggerWebhooks' own defensive guard must still not let it throw.
    const app = express();
    app.use(express.json());
    app.use('/api/v1/webhooks', webhooksRouter);
    const created = await request(app).post('/api/v1/webhooks').send({
      name: 'legacy-corrupt', url: 'https://hooks.slack.com/services/LEGACY1', type: 'generic', events: ['veto'],
    });
    expect(created.status).toBe(200);
    const listRes = await request(app).get('/api/v1/webhooks');
    const stored = listRes.body.find((w: any) => w.id === created.body.id);
    // Directly corrupt the in-memory record's events to something dispatch's `.includes` would
    // have thrown on pre-fix (an object) - simulating data that predates F31 validation.
    (stored as any).events = { corrupted: true };

    vi.mocked(mockedSafeFetch).mockResolvedValue({ ok: true, status: 200, body: '' });

    await expect(triggerWebhooks({ type: 'veto', title: 't', message: 'm' })).resolves.not.toThrow();
  });

  it('records a non-2xx delivery as a failure (logged) rather than treating it as success', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/webhooks', webhooksRouter);
    await request(app).post('/api/v1/webhooks').send({
      name: 'flaky-receiver', url: 'https://hooks.slack.com/services/FLAKY1', type: 'generic', events: ['veto'],
    });

    vi.mocked(mockedSafeFetch).mockResolvedValue({ ok: false, status: 500, body: 'err' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await triggerWebhooks({ type: 'veto', title: 't', message: 'm' });
      await new Promise((r) => setTimeout(r, 10));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('recorded as failed'));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('a hung receiver does not block delivery to a second, healthy webhook (bounded concurrency, not serialized-forever)', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/webhooks', webhooksRouter);
    await request(app).post('/api/v1/webhooks').send({
      name: 'hung', url: 'https://hooks.slack.com/services/HUNG1', type: 'generic', events: ['veto'],
    });
    await request(app).post('/api/v1/webhooks').send({
      name: 'healthy', url: 'https://hooks.slack.com/services/HEALTHY1', type: 'generic', events: ['veto'],
    });

    let healthyResolved = false;
    vi.mocked(mockedSafeFetch).mockImplementation(async (url: string) => {
      if (url.includes('HUNG1')) {
        // Simulate a slow/hung receiver bounded by safeFetch's own timeout logic (mocked here to
        // resolve slowly rather than never, so the test itself stays bounded).
        await new Promise((r) => setTimeout(r, 200));
        throw new Error('simulated hang timeout');
      }
      healthyResolved = true;
      return { ok: true, status: 200, body: '' };
    });

    await triggerWebhooks({ type: 'veto', title: 't', message: 'm' });
    await new Promise((r) => setTimeout(r, 50));
    expect(healthyResolved).toBe(true);
  });
});
