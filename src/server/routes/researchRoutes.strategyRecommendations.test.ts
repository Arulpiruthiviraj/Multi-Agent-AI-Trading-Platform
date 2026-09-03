import { describe, expect, it, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Router } from 'express';

const { getRecommendationById, listRecommendationsForStrategy } = vi.hoisted(() => ({
  getRecommendationById: vi.fn(),
  listRecommendationsForStrategy: vi.fn(),
}));
vi.mock('../research/researchRecommendations', () => ({
  getRecommendationById, listRecommendationsForStrategy, STRATEGY_GRADUATION_KIND: 'STRATEGY_GRADUATION_RECOMMENDATION',
}));
vi.mock('../services/ResearchAgentRunner', () => ({ runStrategyGraduationRecommendation: vi.fn() }));

// Same convention as researchRoutes.strategyGraduation.test.ts - exercises the real
// mountResearchRoutes() function with only the two Phase 3 read-side dependencies mocked.
import { mountResearchRoutes } from './researchRoutes';

function goodView(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    disposition: 'RESEARCH_RECOMMENDATION',
    notATradingApproval: true,
    recommendationId: 'run-1',
    correlationId: 'corr-1',
    strategyId: 'MOMENTUM_BREAKOUT',
    kind: 'STRATEGY_GRADUATION_RECOMMENDATION',
    status: 'COMPLETED',
    failureReason: null,
    graphVersion: 'strategy-graduation-v2',
    providerModel: 'llama3.2:latest',
    durationMs: 1234,
    createdAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    result: {
      lifecycleStatusAtRequest: 'OOS_TESTING', live: 'NO-GO', failedGatesAtRequest: ['MIN_PAPER_TRADES'],
      recommendation: 'NOT_YET_ELIGIBLE', confidence: 0.3, rationale: 'x', limitations: [], evidenceUsed: [],
      counterEvidence: ['Sample is thin.'], missingEvidence: [], evidenceStrength: 'WEAK',
      evidenceStrengthRationale: '3/22 gates pass.', humanReviewRequired: true,
      provenance: { source: 'argus_strategy_evidence_endpoint', strategyId: 'MOMENTUM_BREAKOUT', fetchedAt: '2026-01-01T00:00:00.000Z' },
      modelGeneratedNarrative: 'y',
    },
    stale: false,
    evidenceAgeMs: 1000,
    ...overrides,
  };
}

describe('researchRoutes: strategy-recommendations (Phase 3 human-review read API)', () => {
  let app: express.Express;

  beforeEach(() => {
    getRecommendationById.mockReset();
    listRecommendationsForStrategy.mockReset();
    app = express();
    app.use(express.json());
    const v2Router = Router();
    mountResearchRoutes(v2Router);
    app.use('/api/v2', v2Router);
  });

  it('GET /research/strategy-recommendations/:recommendationId returns 404 when the id does not exist', async () => {
    getRecommendationById.mockResolvedValue(null);
    const res = await request(app).get('/api/v2/research/strategy-recommendations/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('RECOMMENDATION_NOT_FOUND');
  });

  it('GET /research/strategy-recommendations/:recommendationId returns a fully labeled view for a real id', async () => {
    getRecommendationById.mockResolvedValue(goodView());
    const res = await request(app).get('/api/v2/research/strategy-recommendations/run-1');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.live).toBe('NO-GO');
    expect(res.body.disposition).toBe('RESEARCH_RECOMMENDATION');
    expect(res.body.notATradingApproval).toBe(true);
    expect(res.body.result.recommendation).toBe('NOT_YET_ELIGIBLE');
    expect(getRecommendationById).toHaveBeenCalledWith('run-1');
  });

  it('GET /research/strategy-recommendations requires a strategyId query param', async () => {
    const res = await request(app).get('/api/v2/research/strategy-recommendations');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('STRATEGY_ID_REQUIRED');
    expect(listRecommendationsForStrategy).not.toHaveBeenCalled();
  });

  it('GET /research/strategy-recommendations?strategyId=X returns 404 for an unknown strategy id without querying the DB', async () => {
    const res = await request(app).get('/api/v2/research/strategy-recommendations').query({ strategyId: 'NOT_A_REAL_STRATEGY' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('UNKNOWN_STRATEGY_ID');
    expect(listRecommendationsForStrategy).not.toHaveBeenCalled();
  });

  it('GET /research/strategy-recommendations?strategyId=X returns the list for a known strategy', async () => {
    listRecommendationsForStrategy.mockResolvedValue([goodView(), goodView({ recommendationId: 'run-2' })]);
    const res = await request(app).get('/api/v2/research/strategy-recommendations').query({ strategyId: 'MOMENTUM_BREAKOUT' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.recommendations).toHaveLength(2);
    expect(listRecommendationsForStrategy).toHaveBeenCalledWith('MOMENTUM_BREAKOUT', 20);
  });

  it('GET /research/strategy-recommendations passes through a custom limit', async () => {
    listRecommendationsForStrategy.mockResolvedValue([]);
    await request(app).get('/api/v2/research/strategy-recommendations').query({ strategyId: 'MOMENTUM_BREAKOUT', limit: '5' });
    expect(listRecommendationsForStrategy).toHaveBeenCalledWith('MOMENTUM_BREAKOUT', 5);
  });

  it('never exposes a promotion/enable/order action field in the response shape (only the reviewed enum VALUE may legitimately contain the word)', async () => {
    getRecommendationById.mockResolvedValue(goodView());
    const res = await request(app).get('/api/v2/research/strategy-recommendations/run-1');
    const bodyText = JSON.stringify(res.body);
    expect(bodyText).not.toMatch(/placeOrder|enableStrategy|approveTrade|liveArm|CHIEF_APPROVED_IDEA/i);
  });
});
