import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { StrategyLifecycleStatus } from './StrategyEmissionEligibility';

describe('StrategyEmissionEligibility', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let mod: typeof import('./StrategyEmissionEligibility');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_strategy_quarantine_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../../db'));
    mod = await import('./StrategyEmissionEligibility');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('a strategy with no learning_versions row at all is never quarantined', async () => {
    expect(await mod.isStrategyQuarantinedForEmission('NEVER_TOUCHED_STRATEGY')).toBe(false);
  });

  it('quarantineStrategyForEmission marks a strategy RETIRED for emission without deleting anything', async () => {
    await mod.quarantineStrategyForEmission(
      'PULLBACK_CONTINUATION',
      'Repeatedly verified BELOW_CHANCE evidence (effN~22, win rate~22.7%, Wilson lower~0.101)',
      { effectiveN: 22, winRate: 0.227, wilsonLower: 0.101 },
      22,
    );
    expect(await mod.isStrategyQuarantinedForEmission('PULLBACK_CONTINUATION')).toBe(true);
    // A different strategy is completely unaffected.
    expect(await mod.isStrategyQuarantinedForEmission('TREND_FOLLOWING')).toBe(false);
  });

  it('reinstateStrategyForEmission restores eligibility - the most recent decision always wins, history is never overwritten', async () => {
    const t0 = new Date('2026-08-01T00:00:00.000Z');
    const t1 = new Date('2026-08-02T00:00:00.000Z');
    const t2 = new Date('2026-08-03T00:00:00.000Z');

    await mod.quarantineStrategyForEmission('TEMP_STRATEGY', 'test quarantine', {}, 5, t0);
    expect(await mod.isStrategyQuarantinedForEmission('TEMP_STRATEGY')).toBe(true);

    await mod.reinstateStrategyForEmission('TEMP_STRATEGY', 'recovered with new regime-specific evidence', t1);
    expect(await mod.isStrategyQuarantinedForEmission('TEMP_STRATEGY')).toBe(false);

    // Re-quarantining again still works - append-only history, not a toggle on one row.
    await mod.quarantineStrategyForEmission('TEMP_STRATEGY', 'relapsed', {}, 8, t2);
    expect(await mod.isStrategyQuarantinedForEmission('TEMP_STRATEGY')).toBe(true);
  });

  it('filterQuarantinedStrategies removes only the quarantined strategy, preserving every other evaluation untouched', async () => {
    await mod.quarantineStrategyForEmission('QUARANTINED_ONE', 'test', {}, 10);
    const evaluations = [
      { strategy: 'QUARANTINED_ONE', setupScore: 90 },
      { strategy: 'TREND_FOLLOWING', setupScore: 50 },
      { strategy: 'RANGE_REVERSION', setupScore: 30 },
    ];
    const filtered = await mod.filterQuarantinedStrategies(evaluations);
    expect(filtered.map((e) => e.strategy).sort()).toEqual(['RANGE_REVERSION', 'TREND_FOLLOWING']);
  });

  it('filterQuarantinedStrategies is a no-op (same evaluations, not even a new array reference needed conceptually) when nothing is quarantined', async () => {
    const evaluations = [{ strategy: 'MOMENTUM_BREAKOUT', setupScore: 40 }];
    const filtered = await mod.filterQuarantinedStrategies(evaluations);
    expect(filtered).toEqual(evaluations);
  });

  it('filterQuarantinedStrategies handles an empty array without querying the database', async () => {
    const filtered = await mod.filterQuarantinedStrategies([]);
    expect(filtered).toEqual([]);
  });

  it('getStrategyLifecycleStatus reports UNTESTED for a strategy with no lifecycle row - the current baseline default', async () => {
    expect(await mod.getStrategyLifecycleStatus('BRAND_NEW_STRATEGY')).toBe('UNTESTED');
  });

  it('non-exposure-removing statuses (CANDIDATE, ACTIVE_EXPLORATION, VALIDATED, CHAMPION, SHADOW, ROLLED_BACK) never quarantine - only RETIRED and DEGRADED do', async () => {
    const eligibleStatuses: StrategyLifecycleStatus[] = ['SHADOW', 'CANDIDATE', 'ACTIVE_EXPLORATION', 'VALIDATED', 'CHAMPION', 'ROLLED_BACK'];
    for (const status of eligibleStatuses) {
      const strategyId = `ELIGIBLE_${status}`;
      await mod.recordStrategyLifecycleTransition(strategyId, status, `testing ${status}`, null, 0);
      expect(await mod.isStrategyQuarantinedForEmission(strategyId)).toBe(false);
    }
    await mod.recordStrategyLifecycleTransition('DEGRADED_STRATEGY', 'DEGRADED', 'evidence turned negative', { winRate: 0.3 }, 15);
    expect(await mod.isStrategyQuarantinedForEmission('DEGRADED_STRATEGY')).toBe(true);
  });

  it('getStrategyLifecycleHistory returns the full, timestamped, append-only audit trail in most-recent-first order', async () => {
    const t0 = new Date('2026-07-01T00:00:00.000Z');
    const t1 = new Date('2026-07-15T00:00:00.000Z');
    const t2 = new Date('2026-08-01T00:00:00.000Z');
    await mod.recordStrategyLifecycleTransition('AUDIT_STRATEGY', 'CANDIDATE', 'first showed promise', { n: 5 }, 5, t0);
    await mod.recordStrategyLifecycleTransition('AUDIT_STRATEGY', 'ACTIVE_EXPLORATION', 'granted bounded exposure', { n: 12 }, 12, t1);
    await mod.recordStrategyLifecycleTransition('AUDIT_STRATEGY', 'DEGRADED', 'evidence turned negative', { n: 22, winRate: 0.2 }, 22, t2);

    const history = await mod.getStrategyLifecycleHistory('AUDIT_STRATEGY');
    expect(history.length).toBe(3);
    expect(history.map((h) => h.status)).toEqual(['DEGRADED', 'ACTIVE_EXPLORATION', 'CANDIDATE']);
    expect(history[0].evidence).toEqual({ n: 22, winRate: 0.2 });
    expect(history[0].sampleSize).toBe(22);
    // Every transition is preserved - nothing was overwritten by the later ones.
    expect(history[2].hypothesis).toBe('first showed promise');
  });
});
