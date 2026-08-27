import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('MissedOpportunityDetector persistence + learning integration', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let mod: typeof import('./MissedOpportunityDetector');
  let learningMod: typeof import('./LearningObservationRecorder');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_missedopp_persist_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ sqliteDb } = await import('../db'));
    mod = await import('./MissedOpportunityDetector');
    learningMod = await import('./LearningObservationRecorder');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('persists a missed-opportunity record and can read it back', async () => {
    await mod.persistMissedOpportunities([{
      id: 'miss-int-1', symbol: 'NVDA', detectedAt: new Date().toISOString(), classification: 'AGENT_MISS',
      classificationReason: 'test', evidenceAtDecisionJson: '{}', priceAtDetection: 120,
      evaluationHorizonMinutes: 60, evaluationStatus: 'PENDING',
    }]);
    const rows = await mod.getMissedOpportunities(new Date(Date.now() - 3600000).toISOString());
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('miss-int-1');
    expect(rows[0].evaluationStatus).toBe('PENDING');
  });

  it('persistEvaluation marks the record EVALUATED and automatically records an OBSERVATIONAL learning observation', async () => {
    await mod.persistEvaluation('miss-int-1', {
      priceAtEvaluation: 126, maxFavorableExcursionPct: 5, maxAdverseExcursionPct: -1,
    });

    const rows = await mod.getMissedOpportunities(new Date(Date.now() - 3600000).toISOString());
    const updated = rows.find((r) => r.id === 'miss-int-1');
    expect(updated?.evaluationStatus).toBe('EVALUATED');
    expect(updated?.maxFavorableExcursionPct).toBe(5);

    const observations = await learningMod.getLearningObservations({ observationType: 'MISSED_OPPORTUNITY' });
    expect(observations.length).toBe(1);
    expect(observations[0].symbol).toBe('NVDA');
    expect(observations[0].trustLevel).toBe('OBSERVATIONAL');
    expect(JSON.parse(observations[0].outcomeJson!).maxFavorableExcursionPct).toBe(5);
  });

  it('persistEvaluation on a record that does not exist does not throw and records nothing', async () => {
    await expect(mod.persistEvaluation('nonexistent-id', {
      priceAtEvaluation: 1, maxFavorableExcursionPct: 0, maxAdverseExcursionPct: 0,
    })).resolves.toBeUndefined();
    const observations = await learningMod.getLearningObservations({ observationType: 'MISSED_OPPORTUNITY' });
    expect(observations.length).toBe(1); // still just the one from the previous test - no new row for the missing id
  });
});
