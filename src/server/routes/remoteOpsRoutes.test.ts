import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { EventEmitter } from 'events';
import { eq } from 'drizzle-orm';
import { isAuthEnabled, isSessionValid } from '../core/AuthConfig';

/**
 * Remote ops routes: auth required, unknown jobId → 400, mocked spawn (no real shell).
 */
describe('remoteOpsRoutes', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;
  let mockChild: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; killed: boolean; kill: ReturnType<typeof vi.fn> };

  const AUTH_ENV = {
    AUTH_USERNAME: 'ops-admin',
    AUTH_PASSWORD: 'ops-test-password',
    AUTH_SESSION_SECRET: 'ops-test-session-secret-not-default',
  };

  const SESSION_COOKIE = 'argus_session';
  let sessionToken: string;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_remote_ops_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    Object.assign(process.env, AUTH_ENV);

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');

    sessionToken = `test-session-${Date.now()}`;
    const now = Date.now();
    await db.insert(schema.sessions).values({
      sessionToken,
      username: AUTH_ENV.AUTH_USERNAME,
      expiresAt: now + 86400000,
      lastSeen: now,
      createdAt: now,
    });

    mockChild = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      killed: false,
      kill: vi.fn(() => {
        mockChild.killed = true;
        mockChild.emit('close', 0, null);
      }),
    });

    const remoteOps = await import('../services/RemoteOperationsService');
    remoteOps.setRemoteOpSpawnForTests((_cmd, _args) => mockChild as any);
    remoteOps.resetRemoteOpServiceForTests();

    const logBuf = await import('../services/ServerLogBuffer');
    logBuf.resetServerLogBufferForTests();

    const { mountRemoteOpsRoutes } = await import('./remoteOpsRoutes');
    app = express();
    app.use(express.json());

    app.use(async (req: Request & { actor?: string }, res: Response, next: NextFunction) => {
      if (!isAuthEnabled(AUTH_ENV)) return next();
      const cookies = req.headers.cookie || '';
      const match = cookies.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
      const token = match ? match[1] : null;
      if (!token) return res.status(401).json({ error: 'unauthorized' });
      const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.sessionToken, token)).limit(1);
      if (!isSessionValid(rows[0] ?? null)) return res.status(401).json({ error: 'unauthorized' });
      req.actor = rows[0].username;
      next();
    });

    const router = express.Router();
    mountRemoteOpsRoutes(router);
    app.use('/api/v2', router);
  });

  beforeEach(async () => {
    const remoteOps = await import('../services/RemoteOperationsService');
    remoteOps.resetRemoteOpServiceForTests();
    remoteOps.setRemoteOpSpawnForTests((_cmd, _args) => mockChild as any);
    mockChild = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      killed: false,
      kill: vi.fn(() => {
        mockChild.killed = true;
        mockChild.emit('close', 0, null);
      }),
    });
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
    delete process.env.AUTH_USERNAME;
    delete process.env.AUTH_PASSWORD;
    delete process.env.AUTH_SESSION_SECRET;
  });

  it('returns 401 without session cookie', async () => {
    const res = await request(app).get('/api/v2/system/diagnostics');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('returns 400 for unknown jobId', async () => {
    const res = await request(app)
      .post('/api/v2/system/ops/execute')
      .set('Cookie', `${SESSION_COOKIE}=${sessionToken}`)
      .send({ jobId: 'NOT_ALLOWLISTED' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/Unknown jobId/);
  });

  it('executes allowlisted job via mocked spawn', async () => {
    const res = await request(app)
      .post('/api/v2/system/ops/execute')
      .set('Cookie', `${SESSION_COOKIE}=${sessionToken}`)
      .send({ jobId: 'DB_BACKUP' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.jobId).toBe('DB_BACKUP');
    expect(res.body.state.status).toBe('running');

    mockChild.stdout.emit('data', Buffer.from('backup ok\n'));
    await new Promise<void>((resolve) => {
      mockChild.once('close', () => resolve());
      mockChild.emit('close', 0, null);
    });

    const diag = await request(app)
      .get('/api/v2/system/diagnostics')
      .set('Cookie', `${SESSION_COOKIE}=${sessionToken}`);
    expect(diag.status).toBe(200);
    expect(diag.body.ok).toBe(true);
    expect(diag.body.remoteOp.status).toBe('completed');
    expect(Array.isArray(diag.body.allowedJobs)).toBe(true);
  });

  it('returns recent log lines', async () => {
    const logBuf = await import('../services/ServerLogBuffer');
    logBuf.appendServerLogLine({
      level: 'log',
      text: 'test log line',
      source: 'console',
      category: 'SYSTEM',
    });
    const res = await request(app)
      .get('/api/v2/system/logs/recent')
      .set('Cookie', `${SESSION_COOKIE}=${sessionToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.lines.some((l: { text: string }) => l.text === 'test log line')).toBe(true);
  });
});
