import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('ChampionChallengerService', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let mod: typeof import('./ChampionChallengerService');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_championchallenger_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ sqliteDb } = await import('../db'));
    mod = await import('./ChampionChallengerService');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('evaluatePromotionGate fails below the sample-size floor regardless of metric improvement', () => {
    const result = mod.evaluatePromotionGate({
      metricName: 'accuracy', candidateMetricValue: 0.9, championMetricValue: 0.5, sampleSize: 5,
    });
    expect(result.decision).toBe('FAIL');
    expect(result.reason).toMatch(/Sample size/);
  });

  it('evaluatePromotionGate passes a first-ever champion (no existing champion) once sample size floor is met', () => {
    const result = mod.evaluatePromotionGate({
      metricName: 'accuracy', candidateMetricValue: 0.6, championMetricValue: null, sampleSize: 25,
    });
    expect(result.decision).toBe('PASS');
  });

  it('evaluatePromotionGate fails when improvement is below the required margin', () => {
    const result = mod.evaluatePromotionGate({
      metricName: 'accuracy', candidateMetricValue: 0.51, championMetricValue: 0.50, sampleSize: 25,
    });
    expect(result.decision).toBe('FAIL');
    expect(result.reason).toMatch(/margin/);
  });

  it('evaluatePromotionGate passes when improvement clears the required margin', () => {
    const result = mod.evaluatePromotionGate({
      metricName: 'accuracy', candidateMetricValue: 0.60, championMetricValue: 0.50, sampleSize: 25,
    });
    expect(result.decision).toBe('PASS');
  });

  it('full lifecycle: shadow -> candidate -> promoted champion, then a second candidate replaces it, then rollback restores the first', async () => {
    const versionType = 'test-scoring-strategy';

    const v1 = await mod.createShadowVersion(versionType, JSON.stringify({ weight: 1 }), 'first hypothesis');
    let champion = await mod.getChampion(versionType);
    expect(champion).toBeNull();

    await mod.promoteToCandidate(v1, JSON.stringify({ sample: 25 }), 25);
    const decision1 = await mod.decidePromotion(v1, versionType, {
      metricName: 'accuracy', candidateMetricValue: 0.55, championMetricValue: null, sampleSize: 25,
    });
    expect(decision1.decision).toBe('PASS');

    champion = await mod.getChampion(versionType);
    expect(champion?.id).toBe(v1);
    expect(champion?.status).toBe('CHAMPION');

    const v2 = await mod.createShadowVersion(versionType, JSON.stringify({ weight: 2 }), 'second hypothesis');
    await mod.promoteToCandidate(v2, JSON.stringify({ sample: 30 }), 30);

    const decisionInsufficient = await mod.decidePromotion(v2, versionType, {
      metricName: 'accuracy', candidateMetricValue: 0.56, championMetricValue: 0.55, sampleSize: 30,
    });
    expect(decisionInsufficient.decision).toBe('FAIL');
    champion = await mod.getChampion(versionType);
    expect(champion?.id).toBe(v1);

    const decision2 = await mod.decidePromotion(v2, versionType, {
      metricName: 'accuracy', candidateMetricValue: 0.70, championMetricValue: 0.55, sampleSize: 30,
    });
    expect(decision2.decision).toBe('PASS');

    champion = await mod.getChampion(versionType);
    expect(champion?.id).toBe(v2);

    const history = await mod.getVersionHistory(versionType);
    const retiredV1 = history.find((v) => v.id === v1);
    expect(retiredV1?.status).toBe('RETIRED');

    const promotionHistory = await mod.getPromotionHistory(v2);
    expect(promotionHistory.length).toBe(2);

    await mod.rollbackToVersion(versionType, v1, 'v2 underperformed in paper', 'operator');
    champion = await mod.getChampion(versionType);
    expect(champion?.id).toBe(v1);

    const historyAfterRollback = await mod.getVersionHistory(versionType);
    const rolledBackV2 = historyAfterRollback.find((v) => v.id === v2);
    expect(rolledBackV2?.status).toBe('ROLLED_BACK');

    const rollbackHistory = await mod.getRollbackHistory(versionType);
    expect(rollbackHistory.length).toBe(1);
    expect(rollbackHistory[0].fromVersionId).toBe(v2);
    expect(rollbackHistory[0].toVersionId).toBe(v1);
  });

  it('rollbackToVersion throws when there is no current champion to roll back from', async () => {
    await expect(mod.rollbackToVersion('never-had-a-champion', 'nonexistent', 'test', 'operator'))
      .rejects.toThrow(/No current champion/);
  });
});
