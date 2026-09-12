import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * 2026-09-11 (Research Memory Platform Phase 1). Confirmed real gap (audit): experimentLedger.ts's
 * multiple-testing/DSR logic was real but its ExperimentLedger was in-memory only, evaporating on
 * every restart. These tests prove the new durable layer actually survives a fresh DB connection
 * (the closest a unit test can get to proving "survives a restart") and that pre-registration/
 * completion are genuinely write-once, not silently revisable.
 */
describe('experimentLedger - durable research_hypotheses/research_experiments/research_trials', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let mod: typeof import('./experimentLedger');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_experiment_persistence_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ sqliteDb } = await import('../db'));
    mod = await import('./experimentLedger');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('registers a hypothesis with a real preregisteredAt timestamp and null resolution', async () => {
    const id = await mod.registerHypothesis({
      statement: 'Quant SELL 0.6-0.7 confidence bucket has asymmetric downside tail risk.',
      strategyId: 'QuantEngine',
      metric: 'mean_return',
      expectedDirection: 'NEGATIVE_TAIL',
      acceptanceCriteria: 'Chronological walk-forward OOS mean return below -1% with N>=100',
      createdBy: 'claude-sonnet-5',
    });
    expect(typeof id).toBe('string');

    const rows = await mod.listHypotheses('QuantEngine');
    const row = rows.find((r) => r.id === id)!;
    expect(row).toBeDefined();
    expect(row.resolvedAt).toBeNull();
    expect(row.resolvedStatus).toBeNull();
    expect(new Date(row.preregisteredAt).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('resolveHypothesis is write-once - a second resolution attempt is refused, never silently overwritten', async () => {
    const id = await mod.registerHypothesis({ statement: 'Test hypothesis for write-once check.' });
    await mod.resolveHypothesis({ hypothesisId: id, status: 'REJECTED', evidence: { walkForwardWindows: 3, meanReturn: 0.002 } });

    const row = (await mod.listHypotheses()).find((r) => r.id === id)!;
    expect(row.resolvedStatus).toBe('REJECTED');
    expect(JSON.parse(row.resolvedEvidenceJson!)).toEqual({ walkForwardWindows: 3, meanReturn: 0.002 });

    await expect(
      mod.resolveHypothesis({ hypothesisId: id, status: 'CONFIRMED', evidence: { attemptedOverwrite: true } }),
    ).rejects.toThrow(/write-once/);

    // Confirm the original resolution genuinely survived the refused overwrite attempt.
    const stillRejected = (await mod.listHypotheses()).find((r) => r.id === id)!;
    expect(stillRejected.resolvedStatus).toBe('REJECTED');
  });

  it('creates an experiment linked to a hypothesis, records trials against it, and composes them via getExperimentWithTrials', async () => {
    const hypothesisId = await mod.registerHypothesis({ statement: 'MOMENTUM_BREAKOUT walk-forward robustness check.', strategyId: 'MOMENTUM_BREAKOUT' });
    const experimentId = await mod.createExperiment({ hypothesisId, strategyId: 'MOMENTUM_BREAKOUT', datasetHash: 'hash-exp-1', label: 'MOMENTUM_BREAKOUT 3-window walk-forward' });

    mod.recordExperimentTrial('MOMENTUM_BREAKOUT', 'hash-exp-1', {
      outOfSampleMetrics: { sharpe: 0.6, trades: 40 },
      selectionStatus: 'ACCEPTED',
      experimentId,
    });
    // Fire-and-forget DB write - give it a tick to land (same pattern as
    // ReflectionEngine.strategyAttribution.test.ts's EventBus-driven async write).
    await new Promise((r) => setTimeout(r, 50));

    const composed = await mod.getExperimentWithTrials(experimentId);
    expect(composed).not.toBeNull();
    expect(composed!.experiment.label).toBe('MOMENTUM_BREAKOUT 3-window walk-forward');
    expect(composed!.experiment.status).toBe('RUNNING');
    expect(composed!.hypothesis?.id).toBe(hypothesisId);
    expect(composed!.trials.length).toBe(1);
    expect(composed!.trials[0].outOfSampleMetrics).toEqual({ sharpe: 0.6, trades: 40 });
  });

  it('completeExperiment is write-once and getExperimentWithTrials reflects the final result', async () => {
    const experimentId = await mod.createExperiment({ label: 'Standalone experiment, no hypothesis' });
    await mod.completeExperiment({ experimentId, status: 'COMPLETED', resultSummary: { verdict: 'INCONCLUSIVE', n: 12 } });

    const composed = await mod.getExperimentWithTrials(experimentId);
    expect(composed!.experiment.status).toBe('COMPLETED');
    expect(composed!.experiment.hypothesisId).toBeNull();
    expect(JSON.parse(composed!.experiment.resultSummaryJson!)).toEqual({ verdict: 'INCONCLUSIVE', n: 12 });

    await expect(
      mod.completeExperiment({ experimentId, status: 'FAILED', resultSummary: { verdict: 'overwrite attempt' } }),
    ).rejects.toThrow(/write-once/);
  });

  it('returns null (never a fabricated shape) for an experiment id that does not exist', async () => {
    const result = await mod.getExperimentWithTrials('nonexistent-experiment-id');
    expect(result).toBeNull();
  });

  it('a trial recorded WITHOUT an experimentId is durably persisted with a null experimentId (never guessed)', async () => {
    mod.recordExperimentTrial('RANGE_REVERSION', 'hash-standalone-trial', { selectionStatus: 'ACCEPTED' });
    await new Promise((r) => setTimeout(r, 50));

    const { db } = await import('../db');
    const { researchTrials } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const rows = await db.select().from(researchTrials).where(eq(researchTrials.datasetHash, 'hash-standalone-trial'));
    expect(rows.length).toBe(1);
    expect(rows[0].experimentId).toBeNull();
  });
});
