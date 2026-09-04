import { describe, expect, it, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Router } from 'express';

const { beginStrategyGraduationRun, completeStrategyGraduationRun, cancelResearchRun } = vi.hoisted(() => ({
  beginStrategyGraduationRun: vi.fn(),
  completeStrategyGraduationRun: vi.fn(),
  cancelResearchRun: vi.fn(),
}));
vi.mock('../services/ResearchAgentRunner', () => ({ beginStrategyGraduationRun, completeStrategyGraduationRun, cancelResearchRun }));

// mountResearchRoutes pulls in a large real dependency graph (VectorBTService, replay engine,
// etc.) - only the routes this session added are under test here, exercised through the real
// mountResearchRoutes() function (not reimplemented), with only the LangGraph orchestration layer
// mocked.
import { mountResearchRoutes } from './researchRoutes';

describe('researchRoutes: strategy-evidence / strategy-graduation (LangGraph research service integration)', () => {
  let app: express.Express;

  beforeEach(() => {
    beginStrategyGraduationRun.mockReset();
    completeStrategyGraduationRun.mockReset().mockResolvedValue(undefined);
    cancelResearchRun.mockReset();
    app = express();
    app.use(express.json());
    const v2Router = Router();
    mountResearchRoutes(v2Router);
    app.use('/api/v2', v2Router);
  });

  it('GET /research/strategy-evidence/:strategyId returns 404 for an unknown id', async () => {
    const res = await request(app).get('/api/v2/research/strategy-evidence/NOT_A_REAL_STRATEGY');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('UNKNOWN_STRATEGY_ID');
  });

  it('GET /research/strategy-evidence/:strategyId returns structured evidence for a known id', async () => {
    const res = await request(app).get('/api/v2/research/strategy-evidence/GOLDEN_SMA');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.live).toBe('NO-GO');
    expect(res.body).toHaveProperty('lifecycleStatus');
    expect(res.body).toHaveProperty('failedGates');
    expect(res.body).toHaveProperty('evidence');
  });

  it('POST /research/strategy-graduation/:strategyId returns 404 for an unknown id without ever invoking the runner', async () => {
    const res = await request(app).post('/api/v2/research/strategy-graduation/NOT_A_REAL_STRATEGY');
    expect(res.status).toBe(404);
    expect(beginStrategyGraduationRun).not.toHaveBeenCalled();
  });

  it('POST /research/strategy-graduation/:strategyId (Phase 3.1) returns immediately with PENDING and never blocks on the slow completion', async () => {
    beginStrategyGraduationRun.mockResolvedValue({ runId: 'run-1', correlationId: 'corr-1', status: 'PENDING' });
    // completeStrategyGraduationRun deliberately never resolves in this test - if the route awaited
    // it, this request would hang and the test would time out. It doesn't hang, proving the route
    // truly does not await the slow path.
    completeStrategyGraduationRun.mockReturnValue(new Promise(() => {}));

    const res = await request(app).post('/api/v2/research/strategy-graduation/GOLDEN_SMA');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.live).toBe('NO-GO');
    expect(res.body.shadowOnly).toBe(true);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.runId).toBe('run-1');
    expect(beginStrategyGraduationRun).toHaveBeenCalledWith({ strategyId: 'GOLDEN_SMA' });
    expect(completeStrategyGraduationRun).toHaveBeenCalledWith('run-1', 'corr-1', 'GOLDEN_SMA');
  });

  it('POST /research/strategy-graduation/:strategyId does not invoke the slow path when begin already returned a terminal status (e.g. max concurrency)', async () => {
    beginStrategyGraduationRun.mockResolvedValue({ runId: 'run-2', correlationId: 'corr-2', status: 'FAILED' });
    const res = await request(app).post('/api/v2/research/strategy-graduation/GOLDEN_SMA');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('FAILED');
    expect(completeStrategyGraduationRun).not.toHaveBeenCalled();
  });

  it('POST /research/runs/:runId/cancel requires a runId and reports the cancellation outcome', async () => {
    cancelResearchRun.mockResolvedValue({ cancelled: true });
    const res = await request(app).post('/api/v2/research/runs/run-1/cancel');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, cancelled: true });
    expect(cancelResearchRun).toHaveBeenCalledWith('run-1');
  });
});
