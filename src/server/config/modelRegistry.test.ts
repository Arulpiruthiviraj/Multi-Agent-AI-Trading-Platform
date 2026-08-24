import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MODEL_LIFECYCLE_LADDER,
  isValidPromotion,
  isEligibleForLiveConsideration,
  loadEngineOwnershipRegistry,
  getModelStatus,
  getModelEntry,
  resetEngineOwnershipRegistryCacheForTests,
} from './modelRegistry';

describe('modelRegistry - graduation ladder rules', () => {
  it('allows exactly one forward step at a time along the real ladder', () => {
    for (let i = 0; i < MODEL_LIFECYCLE_LADDER.length - 1; i++) {
      expect(isValidPromotion(MODEL_LIFECYCLE_LADDER[i], MODEL_LIFECYCLE_LADDER[i + 1])).toBe(true);
    }
  });

  it('rejects skipping a rung', () => {
    expect(isValidPromotion('RESEARCH', 'SHADOW')).toBe(false);
    expect(isValidPromotion('BACKTEST', 'PAPER')).toBe(false);
    expect(isValidPromotion('RESEARCH', 'PRODUCTION_CANDIDATE')).toBe(false);
  });

  it('rejects moving backward along the ladder', () => {
    expect(isValidPromotion('SHADOW', 'BACKTEST')).toBe(false);
    expect(isValidPromotion('PAPER', 'RESEARCH')).toBe(false);
  });

  it('allows DEPRECATED or DISABLED from any non-terminal rung, without walking back down first', () => {
    for (const rung of MODEL_LIFECYCLE_LADDER) {
      expect(isValidPromotion(rung, 'DEPRECATED')).toBe(true);
      expect(isValidPromotion(rung, 'DISABLED')).toBe(true);
    }
  });

  it('never allows a promotion out of a terminal state', () => {
    expect(isValidPromotion('DEPRECATED', 'RESEARCH')).toBe(false);
    expect(isValidPromotion('DEPRECATED', 'DISABLED')).toBe(false);
    expect(isValidPromotion('DISABLED', 'RESEARCH')).toBe(false);
    expect(isValidPromotion('DISABLED', 'DEPRECATED')).toBe(false);
  });

  it('there is no rung after PRODUCTION_CANDIDATE except the two terminal states', () => {
    expect(isValidPromotion('PRODUCTION_CANDIDATE', 'DEPRECATED')).toBe(true);
    expect(isValidPromotion('PRODUCTION_CANDIDATE', 'DISABLED')).toBe(true);
    expect(isValidPromotion('PRODUCTION_CANDIDATE', 'RESEARCH')).toBe(false);
  });

  it('only VALIDATED/PRODUCTION_CANDIDATE are eligible for any live consideration at all', () => {
    expect(isEligibleForLiveConsideration('VALIDATED')).toBe(true);
    expect(isEligibleForLiveConsideration('PRODUCTION_CANDIDATE')).toBe(true);
    expect(isEligibleForLiveConsideration('SHADOW')).toBe(false);
    expect(isEligibleForLiveConsideration('RESEARCH')).toBe(false);
    expect(isEligibleForLiveConsideration('PAPER')).toBe(false);
    expect(isEligibleForLiveConsideration('DEPRECATED')).toBe(false);
  });
});

describe('modelRegistry - real config/engineOwnership.json loading', () => {
  beforeEach(() => {
    resetEngineOwnershipRegistryCacheForTests();
  });

  it('loads the real repo file and every declared status is a valid ladder/terminal value', () => {
    // Real integration test - if this file is hand-edited with a typo'd status, this test fails,
    // matching the "missing/invalid config keys fail boot" convention this codebase already uses.
    const registry = loadEngineOwnershipRegistry();
    expect(registry.quantModels).toBeDefined();
    expect(getModelStatus('quantModels', 'garch')).toBe('SHADOW');
    expect(getModelStatus('quantModels', 'stat_arb')).toBe('RESEARCH');
  });

  it('returns null for an unknown model id rather than throwing', () => {
    expect(getModelStatus('quantModels', 'NOT_A_REAL_MODEL')).toBeNull();
    expect(getModelEntry('quantModels', 'NOT_A_REAL_MODEL')).toBeNull();
  });
});

describe('modelRegistry - fails closed on an invalid status in the config file', () => {
  beforeEach(() => {
    resetEngineOwnershipRegistryCacheForTests();
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('./loadRepoConfigJson');
    resetEngineOwnershipRegistryCacheForTests();
  });

  it('throws a clear error rather than silently accepting a typo\'d status string', async () => {
    vi.doMock('./loadRepoConfigJson', () => ({
      loadRepoConfigJson: () => ({
        quantModels: { bogus_model: { owner: 'JAVA_ONLY', status: 'NOT_A_REAL_STATUS' } },
      }),
    }));
    const fresh = await import('./modelRegistry');
    expect(() => fresh.loadEngineOwnershipRegistry()).toThrow(/invalid status/i);
  });
});
