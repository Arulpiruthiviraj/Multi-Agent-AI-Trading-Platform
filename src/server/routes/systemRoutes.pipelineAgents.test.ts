import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';
import { pipelineAgentsConfig } from '../config/pipelineAgents';
import { setPipelineAgentEnabled, setAllTogglableIdeaAgents } from '../core/pipelineAgentGate';

/**
 * Regression: App.tsx uses exactly `fetch("/api/v1/system/pipeline-agents")`.
 * A missing Express registration falls through server.ts's `app.all('/api/*')` as
 * "API route not found: /api/v1/system/pipeline-agents". This suite mirrors the
 * production mount stack: systemRouter + explicit app.get/post failsafes + catch-all.
 */
describe('SPA path /api/v1/system/pipeline-agents (production mount stack)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let app: express.Express;

  const technicalId = pipelineAgentsConfig.togglableIdeaAgents.find((a) => a.label === 'Technical')!.id;
  const riskId = pipelineAgentsConfig.alwaysOn.find((a) => a.label === 'Risk Engine')!.id;
  /** Exact string App.tsx fetch() uses — do not change without updating the SPA. */
  const SPA_PATH = '/api/v1/system/pipeline-agents';

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_pipeline_agents_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    const dbMod = await import('../db');
    sqliteDb = dbMod.sqliteDb;
    await dbMod.db.insert((await import('../db/schema')).settings).values({});
    const {
      systemRouter,
      handlePipelineAgentsGet,
      handlePipelineAgentsPost,
    } = await import('./systemRoutes');
    const { tradingLimiter } = await import('../core/RateLimiters');

    app = express();
    app.use(express.json());
    // Same order as server.ts: nested router, then explicit full-path failsafes, then catch-all.
    app.use('/api/v1', systemRouter);
    app.get(SPA_PATH, handlePipelineAgentsGet);
    app.post(SPA_PATH, tradingLimiter, handlePipelineAgentsPost);
    app.all('/api/*', (req, res) => {
      const shown = req.originalUrl?.split('?')[0] || req.path;
      res.status(404).json({ error: 'API route not found: ' + shown });
    });
  });

  afterEach(() => {
    setAllTogglableIdeaAgents(true);
    setPipelineAgentEnabled(technicalId, true);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('GET matches App.tsx fetch path and must not hit catch-all 404', async () => {
    const res = await request(app).get(SPA_PATH);
    expect(res.status).not.toBe(404);
    expect(String(res.body?.error ?? '')).not.toMatch(/API route not found/i);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.togglable)).toBe(true);
    expect(res.body.togglable.length).toBe(pipelineAgentsConfig.togglableIdeaAgents.length);
    expect(Array.isArray(res.body.alwaysOn)).toBe(true);
    expect(res.body.alwaysOn.some((a: any) => a.id === riskId)).toBe(true);
    expect(res.body.alwaysOn.every((a: any) => a.enabled === true)).toBe(true);
  });

  it('POST toggle persists settings.pipelineAgentEnabledJson', async () => {
    const res = await request(app)
      .post(SPA_PATH)
      .send({ agentId: technicalId, enabled: false });
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const row = res.body.togglable.find((a: any) => a.id === technicalId);
    expect(row?.enabled).toBe(false);

    const { db } = await import('../db');
    const schema = await import('../db/schema');
    const settingsRows = await db.select().from(schema.settings).limit(1);
    const parsed = JSON.parse(settingsRows[0].pipelineAgentEnabledJson || '{}');
    expect(parsed[technicalId]).toBe(false);
  });

  it('POST refuses to disable RiskEngine (always-on)', async () => {
    const res = await request(app)
      .post(SPA_PATH)
      .send({ agentId: riskId, enabled: false });
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(String(res.body.error)).toMatch(/cannot be disabled/i);
  });

  it('explicit failsafe alone still serves SPA path when systemRouter is omitted', async () => {
    const {
      handlePipelineAgentsGet,
      handlePipelineAgentsPost,
    } = await import('./systemRoutes');
    const { tradingLimiter } = await import('../core/RateLimiters');
    const bare = express();
    bare.use(express.json());
    // Only the live-readiness-style explicit mounts — no systemRouter.
    bare.get(SPA_PATH, handlePipelineAgentsGet);
    bare.post(SPA_PATH, tradingLimiter, handlePipelineAgentsPost);
    bare.all('/api/*', (req, res) => {
      const shown = req.originalUrl?.split('?')[0] || req.path;
      res.status(404).json({ error: 'API route not found: ' + shown });
    });

    const res = await request(bare).get(SPA_PATH);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.error).toBeUndefined();
  });
});
