import { describe, expect, it, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Router } from 'express';

const { runStrategyGraduationRecommendation } = vi.hoisted(() => ({ runStrategyGraduationRecommendation: vi.fn() }));
vi.mock('../services/ResearchAgentRunner', () => ({ runStrategyGraduationRecommendation }));

// mountResearchRoutes pulls in a large real dependency graph (VectorBTService, replay engine,
// etc.) - only the two routes this session added are under test here, exercised through the real
// mountResearchRoutes() function (not reimplemented), with only the LangGraph orchestration layer
// mocked.
import { mountResearchRoutes } from './researchRoutes';

describe('researchRoutes: strategy-evidence / strategy-graduation (LangGraph research service integration)', () => {
  let app: express.Express;

  beforeEach(() => {
    runStrategyGraduationRecommendation.mockReset();
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
    expect(runStrategyGraduationRecommendation).not.toHaveBeenCalled();
  });

  it('POST /research/strategy-graduation/:strategyId invokes the runner and reports shadow-only, never-promotes', async () => {
    runStrategyGraduationRecommendation.mockResolvedValue({
      runId: 'run-1', correlationId: 'corr-1', status: 'UNAVAILABLE',
      outcome: { ok: false, reason: 'DISABLED' },
    });
    const res = await request(app).post('/api/v2/research/strategy-graduation/GOLDEN_SMA');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.live).toBe('NO-GO');
    expect(res.body.shadowOnly).toBe(true);
    expect(res.body.status).toBe('UNAVAILABLE');
    expect(runStrategyGraduationRecommendation).toHaveBeenCalledWith({ strategyId: 'GOLDEN_SMA' });
  });
});
