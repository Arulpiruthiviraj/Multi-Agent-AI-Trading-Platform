import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { requestStrategyGraduationRecommendation } = vi.hoisted(() => ({
  requestStrategyGraduationRecommendation: vi.fn(),
}));
vi.mock('./LangGraphResearchService', () => ({
  langGraphResearchService: { requestStrategyGraduationRecommendation },
}));

import { db } from '../db';
import { researchAgentRuns } from '../db/schema';
import { eq } from 'drizzle-orm';
import { langGraphResearch } from '../config/langGraphResearch';
import {
  beginStrategyGraduationRun,
  completeStrategyGraduationRun,
  runStrategyGraduationRecommendation,
  cancelResearchRun,
  resetResearchRunConcurrencyForTests,
  resetOrphanRecoveryForTests,
} from './ResearchAgentRunner';

function goodEnvelope(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    runId: 'graph-run-1', correlationId: 'corr-1', strategyId: 'GOLDEN_SMA', graphVersion: 'strategy-graduation-v2',
    status: 'COMPLETED',
    result: {
      lifecycleStatusAtRequest: 'UNTESTED', live: 'NO-GO', failedGatesAtRequest: [],
      recommendation: 'INSUFFICIENT_EVIDENCE', confidence: 0, rationale: 'x', limitations: [], evidenceUsed: [],
      counterEvidence: [], missingEvidence: [], evidenceStrength: 'NONE', evidenceStrengthRationale: 'x',
      humanReviewRequired: false,
      provenance: { source: 'argus_strategy_evidence_endpoint', strategyId: 'GOLDEN_SMA', fetchedAt: new Date().toISOString() },
      modelGeneratedNarrative: '',
    },
    error: null, durationMs: 10, nodesExecuted: ['fetch_evidence'], providerModel: null,
    ...overrides,
  };
}

async function getRow(id: string) {
  const rows = await db.select().from(researchAgentRuns).where(eq(researchAgentRuns.id, id));
  return rows[0];
}

describe('ResearchAgentRunner (Phase 3.1 asynchronous research execution lifecycle)', () => {
  beforeEach(() => {
    requestStrategyGraduationRecommendation.mockReset();
    resetResearchRunConcurrencyForTests();
    resetOrphanRecoveryForTests();
  });

  afterEach(() => {
    resetResearchRunConcurrencyForTests();
  });

  it('beginStrategyGraduationRun returns immediately with a PENDING row, before any LangGraph call', async () => {
    const begun = await beginStrategyGraduationRun({ strategyId: 'GOLDEN_SMA' });
    expect(begun.status).toBe('PENDING');
    expect(requestStrategyGraduationRecommendation).not.toHaveBeenCalled();
    const row = await getRow(begun.runId);
    expect(row.status).toBe('PENDING');
    expect(row.startedAt).toBeNull();
  });

  it('completeStrategyGraduationRun transitions PENDING -> RUNNING (with startedAt) -> COMPLETED', async () => {
    requestStrategyGraduationRecommendation.mockResolvedValue({ ok: true, envelope: goodEnvelope() });
    const begun = await beginStrategyGraduationRun({ strategyId: 'GOLDEN_SMA' });
    const outcome = await completeStrategyGraduationRun(begun.runId, begun.correlationId, 'GOLDEN_SMA');
    expect(outcome.status).toBe('COMPLETED');
    const row = await getRow(begun.runId);
    expect(row.status).toBe('COMPLETED');
    expect(row.startedAt).not.toBeNull();
    expect(row.completedAt).not.toBeNull();
    expect(JSON.parse(row.resultJson!).recommendation).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('maps a graph-level FAILED envelope to run status FAILED', async () => {
    requestStrategyGraduationRecommendation.mockResolvedValue({
      ok: true, envelope: goodEnvelope({ status: 'FAILED', result: null, error: 'ARGUS_UNREACHABLE: refused' }),
    });
    const begun = await beginStrategyGraduationRun({ strategyId: 'GOLDEN_SMA' });
    const outcome = await completeStrategyGraduationRun(begun.runId, begun.correlationId, 'GOLDEN_SMA');
    expect(outcome.status).toBe('FAILED');
    expect((await getRow(begun.runId)).errorMessage).toBe('ARGUS_UNREACHABLE: refused');
  });

  it('maps a client-level TIMEOUT outcome to the distinct TIMEOUT status (not the generic UNAVAILABLE bucket)', async () => {
    requestStrategyGraduationRecommendation.mockResolvedValue({ ok: false, reason: 'TIMEOUT', detail: 'aborted' });
    const begun = await beginStrategyGraduationRun({ strategyId: 'GOLDEN_SMA' });
    const outcome = await completeStrategyGraduationRun(begun.runId, begun.correlationId, 'GOLDEN_SMA');
    expect(outcome.status).toBe('TIMEOUT');
  });

  it('maps a DISABLED/UNAVAILABLE outcome to run status UNAVAILABLE', async () => {
    requestStrategyGraduationRecommendation.mockResolvedValue({ ok: false, reason: 'DISABLED' });
    const begun = await beginStrategyGraduationRun({ strategyId: 'GOLDEN_SMA' });
    const outcome = await completeStrategyGraduationRun(begun.runId, begun.correlationId, 'GOLDEN_SMA');
    expect(outcome.status).toBe('UNAVAILABLE');
  });

  describe('bounded concurrency (Part C/Q - config maxConcurrentRuns, previously unenforced anywhere)', () => {
    // Slot acquisition happens entirely inside beginStrategyGraduationRun() itself (before any
    // LangGraph call) - so this is testable without any real async timing/held-promise trickery:
    // just call begin() maxConcurrentRuns times without ever completing them, then observe the
    // next begin() reject.
    it('rejects a begin() beyond maxConcurrentRuns with a terminal FAILED row, and never calls LangGraph for it', async () => {
      const runs = [];
      for (let i = 0; i < langGraphResearch.maxConcurrentRuns; i++) {
        runs.push(await beginStrategyGraduationRun({ strategyId: 'GOLDEN_SMA' }));
      }
      expect(runs.every((r) => r.status === 'PENDING')).toBe(true);

      const overflow = await beginStrategyGraduationRun({ strategyId: 'GOLDEN_SMA' });
      expect(overflow.status).toBe('FAILED');
      const overflowRow = await getRow(overflow.runId);
      expect(overflowRow.errorMessage).toContain('MAX_CONCURRENCY_REACHED');
      expect(requestStrategyGraduationRecommendation).not.toHaveBeenCalled(); // none of the above were ever completed
    });

    it('releases its slot on completion, allowing a subsequent run to proceed', async () => {
      requestStrategyGraduationRecommendation.mockResolvedValue({ ok: false, reason: 'DISABLED' });
      for (let i = 0; i < langGraphResearch.maxConcurrentRuns + 3; i++) {
        const begun = await beginStrategyGraduationRun({ strategyId: 'GOLDEN_SMA' });
        expect(begun.status).toBe('PENDING'); // never rejected - each prior iteration fully completed (and released its slot) first
        await completeStrategyGraduationRun(begun.runId, begun.correlationId, 'GOLDEN_SMA');
      }
    });
  });

  describe('idempotent completion / no double-finalization', () => {
    it('cancelResearchRun wins the race against a later completion write - the CANCELLED status is never overwritten', async () => {
      requestStrategyGraduationRecommendation.mockResolvedValue({ ok: true, envelope: goodEnvelope() });
      const begun = await beginStrategyGraduationRun({ strategyId: 'GOLDEN_SMA' });

      const cancelResult = await cancelResearchRun(begun.runId);
      expect(cancelResult.cancelled).toBe(true);
      expect((await getRow(begun.runId)).status).toBe('CANCELLED');

      // The "slow path" LangGraph call still resolves after cancellation (simulating a real
      // in-flight HTTP call that can't be interrupted) - its own completion write must be a no-op.
      const outcome = await completeStrategyGraduationRun(begun.runId, begun.correlationId, 'GOLDEN_SMA');
      expect(outcome.status).toBe('COMPLETED'); // the function's own return value reports what LangGraph said
      const row = await getRow(begun.runId);
      expect(row.status).toBe('CANCELLED'); // but the persisted row was never overwritten
      expect(row.resultJson).toBeNull();
    });

    it('cancelling an already-terminal run is a safe no-op, not an error', async () => {
      requestStrategyGraduationRecommendation.mockResolvedValue({ ok: true, envelope: goodEnvelope() });
      const begun = await beginStrategyGraduationRun({ strategyId: 'GOLDEN_SMA' });
      await completeStrategyGraduationRun(begun.runId, begun.correlationId, 'GOLDEN_SMA');
      const result = await cancelResearchRun(begun.runId);
      expect(result.cancelled).toBe(false);
      expect((await getRow(begun.runId)).status).toBe('COMPLETED');
    });

    it('cancelling an unknown runId is a safe no-op', async () => {
      const result = await cancelResearchRun('does-not-exist');
      expect(result.cancelled).toBe(false);
    });
  });

  describe('restart recovery (Part D/E)', () => {
    it('recovers an orphaned PENDING row (left behind by a prior process) to FAILED_ON_RESTART on the next run start', async () => {
      // Simulate a row a PRIOR process left in PENDING (no in-memory task exists for it in THIS
      // process - resetOrphanRecoveryForTests() + the fresh beforeAll DB per test file means this
      // row was never created by beginStrategyGraduationRun in this test run).
      const orphanId = 'orphan-run-1';
      await db.insert(researchAgentRuns).values({
        id: orphanId, correlationId: 'orphan-corr', kind: 'STRATEGY_GRADUATION_RECOMMENDATION',
        strategyId: 'GOLDEN_SMA', requestJson: '{}', status: 'RUNNING', createdAt: new Date(Date.now() - 60_000).toISOString(),
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      });

      requestStrategyGraduationRecommendation.mockResolvedValue({ ok: false, reason: 'DISABLED' });
      // Any new begin() triggers the once-per-process orphan sweep before creating its own row.
      const begun = await beginStrategyGraduationRun({ strategyId: 'GOLDEN_SMA' });
      await completeStrategyGraduationRun(begun.runId, begun.correlationId, 'GOLDEN_SMA');

      const orphanRow = await getRow(orphanId);
      expect(orphanRow.status).toBe('FAILED_ON_RESTART');
      expect(orphanRow.errorMessage).toMatch(/restarted/i);
    });

    it('only sweeps orphans once per process, not on every begin()', async () => {
      const laterOrphanId = 'orphan-run-2';
      requestStrategyGraduationRecommendation.mockResolvedValue({ ok: false, reason: 'DISABLED' });
      const begun1 = await beginStrategyGraduationRun({ strategyId: 'GOLDEN_SMA' });
      await completeStrategyGraduationRun(begun1.runId, begun1.correlationId, 'GOLDEN_SMA');

      // A row that becomes PENDING AFTER the first sweep already ran must NOT be swept again by a
      // second begin() in the same process - it's a real in-flight run, not an orphan.
      await db.insert(researchAgentRuns).values({
        id: laterOrphanId, correlationId: 'c', kind: 'STRATEGY_GRADUATION_RECOMMENDATION',
        strategyId: 'GOLDEN_SMA', requestJson: '{}', status: 'PENDING', createdAt: new Date().toISOString(),
      });
      const begun2 = await beginStrategyGraduationRun({ strategyId: 'GOLDEN_SMA' });
      await completeStrategyGraduationRun(begun2.runId, begun2.correlationId, 'GOLDEN_SMA');

      expect((await getRow(laterOrphanId)).status).toBe('PENDING'); // untouched by the sweep
    });
  });

  it('runStrategyGraduationRecommendation (sync convenience wrapper) still behaves exactly as before for its remaining caller', async () => {
    requestStrategyGraduationRecommendation.mockResolvedValue({ ok: true, envelope: goodEnvelope() });
    const outcome = await runStrategyGraduationRecommendation({ strategyId: 'GOLDEN_SMA' });
    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.outcome?.ok).toBe(true);
  });
});
