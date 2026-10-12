// LABEL: COMPONENT / FAULT_INJECTION
/**
 * ==========================================================
 * quantSchedulerEmissionLiveness.test.ts — 2026-10-11 scheduler timeliness invariant.
 *
 * Defect: expired/quarantined scheduler evaluations could still emit trade ideas
 * to ChiefTrader as if current — emission happened inside evaluateSymbol before
 * the watchdog's late-settle discard, so the timeliness invariant was defeated at
 * the emission layer.
 *
 * Fix: the scheduler hands evaluateSymbol an isLiveCheck predicate (mirroring the
 * fast lane's isLeaseAuthoritative pattern); the evaluator consults it immediately
 * before emitting. These tests pin the scheduler side of the contract:
 *  - the predicate is passed to evaluateSymbol;
 *  - it reads true while the evaluation is live;
 *  - it reads false once the watchdog quarantines the in-flight evaluation.
 * The agent side (withholding emission when the predicate is false) is pinned in
 * QuantSignalAgent.emitFixture.test.ts.
 * ==========================================================
 */
import { describe, it, expect } from 'vitest';
import {
  QuantPriorityScheduler,
  QuantCandidatePriority,
  type QuantSchedulerDeps,
} from './quantPriorityScheduler';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CapturedCall {
  symbol: string;
  isLiveCheck?: () => boolean;
  liveAtStart: boolean | undefined;
  liveAfterSettle: boolean | undefined;
}

function makeHarness(opts: { quantEvaluationTimeoutMs: number; evaluatorDelayMs: number }) {
  const calls: CapturedCall[] = [];
  const now = Date.now();
  const bars = Array.from({ length: 10 }, (_, i) => ({ timestamp: now - (10 - i) * 86_400_000 }));
  const deps: QuantSchedulerDeps = {
    evaluateSymbol: async (symbol: string, options?: { isLiveCheck?: () => boolean }) => {
      const call: CapturedCall = {
        symbol,
        isLiveCheck: options?.isLiveCheck,
        liveAtStart: options?.isLiveCheck?.(),
        liveAfterSettle: undefined,
      };
      calls.push(call);
      await sleep(opts.evaluatorDelayMs);
      // The late settle observes the predicate AFTER the watchdog has acted.
      call.liveAfterSettle = call.isLiveCheck?.();
      return { stub: true };
    },
    getBars: async () => [...bars],
    ensureBars: async () => {},
    providerRateLimitedUntilMs: () => 0,
    minBars: 1,
    expectedBarCount: () => 10,
    lookbackDays: 10,
    config: { quantEvaluationTimeoutMs: opts.quantEvaluationTimeoutMs },
    emit: () => {},
  };
  const scheduler = new QuantPriorityScheduler(deps);
  return { scheduler, calls };
}

describe('quant scheduler emission liveness (2026-10-11 timeliness invariant)', () => {
  it('passes isLiveCheck to evaluateSymbol; false after watchdog quarantine', async () => {
    const { scheduler, calls } = makeHarness({
      quantEvaluationTimeoutMs: 50,
      evaluatorDelayMs: 300,
    });
    scheduler.start();
    scheduler.admit({
      symbol: 'SLOWX',
      priority: QuantCandidatePriority.P0_URGENT_MOVER,
      source: 'TEST',

    });
    try {
      // Wait for the quarantine to land and the late settle to observe it.
      await sleep(900);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const call = calls[0];
      expect(call.isLiveCheck).toBeDefined();
      // Live at evaluation start (the quarantine had not landed yet).
      expect(call.liveAtStart).toBe(true);
      // Not live after the watchdog quarantined the in-flight evaluation: an
      // evaluator honoring this predicate withholds emission instead of emitting
      // a stale evaluation as if current.
      expect(call.liveAfterSettle).toBe(false);
    } finally {
      scheduler.stop();
    }
  });

  it('isLiveCheck stays true when the evaluation settles before the watchdog', async () => {
    const { scheduler, calls } = makeHarness({
      quantEvaluationTimeoutMs: 10_000,
      evaluatorDelayMs: 50,
    });
    scheduler.start();
    scheduler.admit({
      symbol: 'FASTX',
      priority: QuantCandidatePriority.P0_URGENT_MOVER,
      source: 'TEST',

    });
    try {
      await sleep(600);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const call = calls[0];
      expect(call.isLiveCheck).toBeDefined();
      expect(call.liveAtStart).toBe(true);
      // Settled well before the watchdog: still live, emission permitted.
      expect(call.liveAfterSettle).toBe(true);
    } finally {
      scheduler.stop();
    }
  });
});
