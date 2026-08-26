import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

/**
 * DEF-26 fix (2026-08-26): process.kill(pid, 'SIGTERM') does not invoke the target process's
 * SIGTERM handler on Windows (empirically confirmed live) - the CLI's stop/restart now requests
 * a graceful shutdown via this route instead of relying on an OS signal. Mocks
 * requestGracefulShutdown() itself (already covered by gracefulShutdown.test.ts's own real-drain
 * tests) so this test only proves the route's own contract: respond first, then trigger the
 * shutdown request - never the other way around, and never block the response on the drain.
 */
describe('POST /api/v1/system/shutdown', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let app: express.Express;
  let requestGracefulShutdownMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_systemshutdown_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    requestGracefulShutdownMock = vi.fn(async () => undefined);
    vi.doMock('../core/gracefulShutdown', () => ({
      requestGracefulShutdown: requestGracefulShutdownMock,
    }));

    ({ sqliteDb } = await import('../db'));
    const { systemRouter } = await import('./systemRoutes');
    app = express();
    app.use(express.json());
    app.use('/api/v1', systemRouter);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
    vi.doUnmock('../core/gracefulShutdown');
  });

  it('responds ok:true immediately, then requests the graceful shutdown', async () => {
    const res = await request(app).post('/api/v1/system/shutdown');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, message: 'Graceful shutdown initiated.' });

    // The route defers the actual shutdown request to the next tick (setImmediate) so the
    // response is flushed to the client before the process starts draining - wait one tick.
    await new Promise((resolve) => setImmediate(resolve));
    expect(requestGracefulShutdownMock).toHaveBeenCalledTimes(1);
    expect(requestGracefulShutdownMock).toHaveBeenCalledWith(expect.stringContaining('/api/v1/system/shutdown'));
  });
});
