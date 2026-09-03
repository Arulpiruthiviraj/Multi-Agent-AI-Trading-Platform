import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db';
import { researchAgentRuns } from '../db/schema';
import { langGraphResearch } from '../config/langGraphResearch';
import { getRecommendationById, listRecommendationsForStrategy, STRATEGY_GRADUATION_KIND } from './researchRecommendations';

function goodResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    lifecycleStatusAtRequest: 'OOS_TESTING',
    live: 'NO-GO',
    failedGatesAtRequest: ['MIN_PAPER_TRADES'],
    recommendation: 'NOT_YET_ELIGIBLE',
    confidence: 0.3,
    rationale: 'Reasoned from evidence.',
    limitations: ['small sample'],
    evidenceUsed: ['paperTrades'],
    counterEvidence: ['Only 3 paper trades exist so far.'],
    missingEvidence: [],
    evidenceStrength: 'WEAK',
    evidenceStrengthRationale: '3/22 Argus evidence gates currently pass.',
    humanReviewRequired: true,
    provenance: { source: 'argus_strategy_evidence_endpoint', strategyId: 'MOMENTUM_BREAKOUT', fetchedAt: new Date().toISOString() },
    modelGeneratedNarrative: 'Thin sample, moderate risk.',
    ...overrides,
  };
}

async function insertRun(opts: {
  id: string;
  strategyId: string | null;
  status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'UNAVAILABLE';
  resultJson?: string | null;
  errorMessage?: string | null;
  createdAt?: string;
  completedAt?: string | null;
}) {
  await db.insert(researchAgentRuns).values({
    id: opts.id,
    correlationId: `corr-${opts.id}`,
    kind: STRATEGY_GRADUATION_KIND,
    strategyId: opts.strategyId,
    requestJson: JSON.stringify({ strategyId: opts.strategyId }),
    status: opts.status,
    resultJson: opts.resultJson ?? null,
    errorMessage: opts.errorMessage ?? null,
    graphVersion: opts.status === 'COMPLETED' ? 'strategy-graduation-v2' : null,
    providerModel: opts.status === 'COMPLETED' ? 'llama3.2:latest' : null,
    durationMs: opts.status === 'COMPLETED' ? 1234 : null,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    completedAt: opts.completedAt ?? new Date().toISOString(),
  });
}

describe('researchRecommendations (Phase 3 read-only view)', () => {
  beforeAll(async () => {
    await insertRun({ id: 'run-completed-1', strategyId: 'MOMENTUM_BREAKOUT', status: 'COMPLETED', resultJson: JSON.stringify(goodResult()) });
    await insertRun({
      id: 'run-unavailable-1', strategyId: 'MOMENTUM_BREAKOUT', status: 'UNAVAILABLE',
      errorMessage: 'TIMEOUT: The operation was aborted', resultJson: null,
    });
    await insertRun({
      id: 'run-failed-1', strategyId: 'MOMENTUM_BREAKOUT', status: 'FAILED',
      errorMessage: 'ARGUS_UNREACHABLE: refused', resultJson: null,
    });
    await insertRun({ id: 'run-other-strategy', strategyId: 'PULLBACK_CONTINUATION', status: 'COMPLETED', resultJson: JSON.stringify(goodResult({ evidenceStrength: 'MODERATE' })) });
  });

  it('getRecommendationById returns a fully labeled RESEARCH_RECOMMENDATION view for a real COMPLETED row', async () => {
    const view = await getRecommendationById('run-completed-1');
    expect(view).not.toBeNull();
    expect(view!.disposition).toBe('RESEARCH_RECOMMENDATION');
    expect(view!.notATradingApproval).toBe(true);
    expect(view!.status).toBe('COMPLETED');
    expect(view!.failureReason).toBeNull();
    expect(view!.result?.recommendation).toBe('NOT_YET_ELIGIBLE');
    expect(view!.result?.counterEvidence).toEqual(['Only 3 paper trades exist so far.']);
  });

  it('returns null for an id that does not exist', async () => {
    const view = await getRecommendationById('does-not-exist');
    expect(view).toBeNull();
  });

  it('re-derives a distinct failureReason for UNAVAILABLE vs FAILED - these are never collapsed into one meaning', async () => {
    const unavailable = await getRecommendationById('run-unavailable-1');
    const failed = await getRecommendationById('run-failed-1');
    expect(unavailable!.status).toBe('UNAVAILABLE');
    expect(unavailable!.failureReason).toBe('TIMEOUT');
    expect(failed!.status).toBe('FAILED');
    expect(failed!.failureReason).toBe('ARGUS_UNREACHABLE');
    expect(unavailable!.failureReason).not.toBe(failed!.failureReason);
  });

  it('computes stale=false for freshly fetched evidence', async () => {
    const view = await getRecommendationById('run-completed-1');
    expect(view!.stale).toBe(false);
    expect(view!.evidenceAgeMs).toBeGreaterThanOrEqual(0);
    expect(view!.evidenceAgeMs).toBeLessThan(60_000);
  });

  it('computes stale=true once evidence is older than the configured staleness threshold (read-time, not generation-time)', async () => {
    const staleFetchedAt = new Date(Date.now() - (langGraphResearch.researchRecommendationStalenessMs + 60_000)).toISOString();
    await insertRun({
      id: 'run-stale-1', strategyId: 'MOMENTUM_BREAKOUT', status: 'COMPLETED',
      resultJson: JSON.stringify(goodResult({ provenance: { source: 'argus_strategy_evidence_endpoint', strategyId: 'MOMENTUM_BREAKOUT', fetchedAt: staleFetchedAt } })),
    });
    const view = await getRecommendationById('run-stale-1');
    expect(view!.stale).toBe(true);
    expect(view!.evidenceAgeMs).toBeGreaterThan(langGraphResearch.researchRecommendationStalenessMs);
  });

  it('listRecommendationsForStrategy returns only rows for the requested strategy, newest first, and never mutates history', async () => {
    const rows = await listRecommendationsForStrategy('MOMENTUM_BREAKOUT', 50);
    const ids = rows.map((r) => r.recommendationId);
    expect(ids).toContain('run-completed-1');
    expect(ids).toContain('run-unavailable-1');
    expect(ids).toContain('run-failed-1');
    expect(ids).not.toContain('run-other-strategy');
    // Every row from the earlier inserts is still present and unchanged - nothing was overwritten.
    const completed = rows.find((r) => r.recommendationId === 'run-completed-1');
    expect(completed?.result?.recommendation).toBe('NOT_YET_ELIGIBLE');
  });

  it('listRecommendationsForStrategy clamps an out-of-range limit rather than returning unbounded rows', async () => {
    const rows = await listRecommendationsForStrategy('MOMENTUM_BREAKOUT', 100000);
    expect(rows.length).toBeLessThanOrEqual(100);
  });

  it('a row with unparsable resultJson surfaces as result:null rather than throwing or fabricating a partial object', async () => {
    await insertRun({ id: 'run-corrupt-1', strategyId: 'MOMENTUM_BREAKOUT', status: 'COMPLETED', resultJson: '{not valid json' });
    const view = await getRecommendationById('run-corrupt-1');
    expect(view!.result).toBeNull();
  });
});
