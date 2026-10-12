// LABEL: COMPONENT
/**
 * ==========================================================
 * quantSchedulerSingletonReinit.test.ts — 2026-10-11 defect 2 regression.
 *
 * Defect: QuantSignalAgent.runCycle only initialized the priority scheduler when
 * the singleton was null, but initQuantPriorityScheduler retires stopped
 * singletons — so a stopped NON-NULL singleton was reused, every admission
 * returned NOT_ELIGIBLE (SCHEDULER_NOT_RUNNING), and the cycle reported
 * COMPLETED with zero evaluations (silent dead cycles).
 *
 * Fix: runCycle calls initPriorityScheduler() unconditionally every cycle; the
 * module init drops a stopped singleton and builds a fresh one.
 *
 * These tests pin: (1) a stopped non-null singleton rejects admissions, and
 * (2) re-init (what runCycle now does every cycle) revives a fresh scheduler
 * whose admissions proceed.
 * ==========================================================
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  initQuantPriorityScheduler,
  getQuantPriorityScheduler,
  resetQuantPrioritySchedulerForTests,
  QuantCandidatePriority,
  type QuantSchedulerDeps,
} from './quantPriorityScheduler';

function makeDeps(): QuantSchedulerDeps {
  return {
    evaluateSymbol: async () => ({ stub: true }),
    getBars: async () => [],
    ensureBars: async () => ({ status: 'READY' as const, bars: [] }),
    providerRateLimitedUntilMs: () => 0,
    minBars: 1,
    expectedBarCount: () => 1,
    lookbackDays: 1,
    emit: () => {},
  };
}

describe('quant scheduler singleton re-init (2026-10-11 defect 2)', () => {
  afterEach(() => {
    resetQuantPrioritySchedulerForTests();
  });

  it('stopped non-null singleton rejects admissions with NOT_ELIGIBLE', () => {
    const s1 = initQuantPriorityScheduler(makeDeps());
    expect(getQuantPriorityScheduler()).toBe(s1);
    expect(s1.isStopped()).toBe(false);

    s1.stop();
    // The stopped singleton is still non-null (this is the defect-2 state).
    expect(getQuantPriorityScheduler()).toBe(s1);
    expect(s1.isStopped()).toBe(true);

    const admission = s1.admit({
      symbol: 'DEADX',
      priority: QuantCandidatePriority.P0_URGENT_MOVER,
      reason: 'defect-2 test',
    });
    expect(admission).toMatchObject({ accepted: false });
    if ('terminalState' in admission) {
      expect(admission.terminalState).toBe('NOT_ELIGIBLE');
    }
  });

  it('unconditional re-init revives a fresh scheduler; admissions proceed', () => {
    const s1 = initQuantPriorityScheduler(makeDeps());
    s1.stop();
    expect(getQuantPriorityScheduler()).toBe(s1);

    // This is what QuantSignalAgent.runCycle now does every cycle (unconditional).
    const s2 = initQuantPriorityScheduler(makeDeps());
    expect(s2).not.toBe(s1);
    expect(getQuantPriorityScheduler()).toBe(s2);
    expect(s2.isStopped()).toBe(false);

    const admission = s2.admit({
      symbol: 'LIVE1',
      priority: QuantCandidatePriority.P0_URGENT_MOVER,
      reason: 'defect-2 test',
    });
    expect(admission).toMatchObject({ accepted: true });
  });
});
