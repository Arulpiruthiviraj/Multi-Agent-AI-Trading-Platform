import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';
import { isAuthEnabled, isSessionValid, allowUnauthenticatedRequest } from '../core/AuthConfig';
import { redactSecrets } from '../core/SecretRedaction';

/**
 * Automated security regressions the forensic audit lacked.
 * Honest scope: these are contract tests, NOT a penetration test.
 */
describe('paper-readiness security contracts (not a pentest)', () => {
  it('AUTH_PASSWORD set means unauthenticated mutating/API access is denied at the gate', () => {
    const env = {
      AUTH_USERNAME: 'admin',
      AUTH_PASSWORD: 'unit-test-password-not-real',
      AUTH_SESSION_SECRET: 'unit-test-session-secret-not-real',
    };
    expect(isAuthEnabled(env)).toBe(true);
    expect(allowUnauthenticatedRequest({
      method: 'GET', path: '/api/v1/config/settings', ip: '10.0.0.8', env,
    })).toBe(false);
    expect(allowUnauthenticatedRequest({
      method: 'POST', path: '/api/v2/trading/execute-override', ip: '10.0.0.8', env,
    })).toBe(false);
    expect(isSessionValid(null)).toBe(false);
  });

  it('redacts Bearer tokens and compact JWTs (extends SecretRedaction; does not log secrets)', () => {
    const bearer = 'Authorization: Bearer supersecret.jwt.payloadvaluehere';
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb';
    expect(redactSecrets(bearer)).toContain('Bearer [REDACTED]');
    expect(redactSecrets(bearer)).not.toContain('supersecret.jwt.payloadvaluehere');
    expect(redactSecrets(`Authorization: ${jwt}`)).toContain('[REDACTED_JWT]');
    expect(redactSecrets(`Authorization: ${jwt}`)).not.toContain('aaaaaaaaaaaaaaaa');
  });
});

describe('unauthenticated trading/settings/OMS routes return 401 when AUTH is on', { timeout: 60000 }, () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    // Mirrors server.ts auth gate: /health /ready stay public; /api/* requires a session.
    app.use((req, res, next) => {
      if (req.path === '/health' || req.path === '/ready') return next();
      if (req.path.startsWith('/api/v1/auth')) return next();
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
      next();
    });
    app.get('/health', (_req, res) => res.json({ status: 'ok' }));
    app.get('/ready', (_req, res) => res.json({ status: 'ready' }));
    app.get('/api/v1/config/settings', (_req, res) => res.json({ ok: true }));
    app.post('/api/v2/trading/execute-override', (_req, res) => res.json({ ok: true }));
    app.post('/api/v1/autobot/toggle', (_req, res) => res.json({ ok: true }));
    app.get('/api/v1/system/export-db', (_req, res) => res.json({ ok: true }));
  });

  it('denies unauthenticated GET settings, POST override, POST autobot, GET export-db with 401', async () => {
    expect((await request(app).get('/api/v1/config/settings')).status).toBe(401);
    expect((await request(app).post('/api/v2/trading/execute-override').send({ symbol: 'AAPL' })).status).toBe(401);
    expect((await request(app).post('/api/v1/autobot/toggle').send({ enabled: true })).status).toBe(401);
    expect((await request(app).get('/api/v1/system/export-db')).status).toBe(401);
  });

  it('GET /health and /ready remain unauthenticated by design', async () => {
    expect((await request(app).get('/health')).status).toBe(200);
    expect((await request(app).get('/ready')).status).toBe(200);
  });
});

describe('query-param injection and export/import path safety (not a pentest)', { timeout: 60000 }, () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_sec_routes_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ sqliteDb } = await import('../db'));
    const { newsRouter } = await import('../routes/newsRoutes');
    const { traceRouter } = await import('../routes/traceRoutes');
    const { systemRouter } = await import('../routes/systemRoutes');
    app = express();
    app.use('/api/v1/news', newsRouter);
    app.use('/api/v2/traces', traceRouter);
    app.use('/api/v1', systemRouter);
  }, 60_000);

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const f of fs.readdirSync(path.dirname(tmpDbPath))) {
      if (f.startsWith(path.basename(tmpDbPath))) {
        try { fs.unlinkSync(path.join(path.dirname(tmpDbPath), f)); } catch { /* best-effort */ }
      }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('news memory and traces list reject injection payloads without dumping schema', async () => {
    const payload = "'; DROP TABLE trades; --";
    const mem = await request(app).get('/api/v1/news/memory').query({ symbol: payload });
    expect(mem.status).not.toBe(500);
    expect(JSON.stringify(mem.body)).not.toMatch(/sqlite_master|CREATE TABLE/i);

    const traces = await request(app).get('/api/v2/traces').query({ symbol: payload, limit: '1' });
    expect(traces.status).not.toBe(500);
    expect(JSON.stringify(traces.body)).not.toMatch(/sqlite_master|CREATE TABLE/i);

    const stillThere = sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='trades'").get();
    expect(stillThere).toBeTruthy();
  });

  it('export-db ignores traversal query params and only serves the configured SQLite file', async () => {
    const res = await request(app)
      .get('/api/v1/system/export-db')
      .query({ file: '../../../../etc/passwd', path: '..\\..\\windows\\win.ini' })
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition'] || '').toMatch(/argus_backup\.db/i);
    const bytes = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body);
    expect(bytes.subarray(0, 16).toString('utf8')).toBe('SQLite format 3\0');
  });

  it('import-db refuses a non-sqlite upload even if named like a traversal', async () => {
    const res = await request(app)
      .post('/api/v1/system/import-db')
      .set('Content-Type', 'application/octet-stream')
      .query({ dest: '../../tmp/evil.db' })
      .send(Buffer.from('../../etc/passwd'));
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});
