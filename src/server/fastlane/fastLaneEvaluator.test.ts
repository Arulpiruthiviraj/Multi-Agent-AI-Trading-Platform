import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fastLaneManager } from './FastLaneManager';
import { quantSignalAgent } from '../services/QuantSignalAgent';
import {
  evaluateFastCandidate,
  resetFastLaneEvaluatorForTests,
  fastLaneActiveEvaluationCountForTests,
  fastLaneEvaluatorGenerationForTests,
  reapHungFastLaneLeasesForTests,
  getFastLaneLeaseSnapshot,
} from './fastLaneEvaluator';
import { tradingSafety } from '../config/tradingSafety';

function inject(symbol: string, ttlMs = 60 * 60_000) {
  return fastLaneManager.injectCandidate({
    symbol,
    detectionSource: 'NEWS_CATALYST',
    liquidityEvidence: { dollarVolume: null, spreadBps: null, meetsMinLiquidity: false },
    ttlMs,
  })!;
}

function fakeEvaluation(evaluations: Array<{ strategy: string; side: 'BUY' | 'SELL'; triggerMet: boolean; confidence: number }>) {
  return {
    regime: {} as any,
    marketContext: {} as any,
    strategyEvaluations: evaluations.map((e) => ({
      strategy: e.strategy,
      side: e.side,
      setupScore: 80,
      confidence: e.confidence,
      triggerMet: e.triggerMet,
      conditionsMet: [],
      conditionsFailed: [],
      contradictions: [],
      invalidationConditions: [],
    })) as any,
    groupedScores: { BUY: {} as any, SELL: {} as any },
    aiContradictionAnalysis: null,
  };
}

beforeEach(() => {
  process.env.FAST_OPPORTUNITY_LANE_ENABLED = 'true';
});

afterEach(() => {
  delete process.env.FAST_OPPORTUNITY_LANE_ENABLED;
  fastLaneManager.resetForTests();
  resetFastLaneEvaluatorForTests();
  vi.restoreAllMocks();
});

describe('fastLaneEvaluator (research/paper only, no execution authority)', () => {
  it('candidate + insufficient data -> INSUFFICIENT_DATA, no evaluation evidence fabricated', async () => {
    const c = inject('AAAAA');
    vi.spyOn(quantSignalAgent, 'evaluateSymbol').mockResolvedValue(null); // real "not enough bars" return
    const result = await evaluateFastCandidate(c.id);
    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.reasonCodes).toContain('INSUFFICIENT_REAL_BARS');
    expect(result.bestStrategy).toBeUndefined();
    expect(result.confidence).toBeUndefined();
  });

  it('candidate + a real triggered strategy -> VALID_STRATEGY_EVIDENCE, with the real strategy/side/confidence carried through', async () => {
    const c = inject('BBBBB');
    vi.spyOn(quantSignalAgent, 'evaluateSymbol').mockResolvedValue(fakeEvaluation([
      { strategy: 'MOMENTUM_BREAKOUT', side: 'BUY', triggerMet: true, confidence: 0.82 },
      { strategy: 'MEAN_REVERSION', side: 'SELL', triggerMet: false, confidence: 0.1 },
    ]) as any);
    const result = await evaluateFastCandidate(c.id);
    expect(result.status).toBe('VALID_STRATEGY_EVIDENCE');
    expect(result.bestStrategy).toBe('MOMENTUM_BREAKOUT');
    expect(result.direction).toBe('BUY');
    expect(result.confidence).toBe(0.82);
    expect(result.validTriggers).toContain('MOMENTUM_BREAKOUT');
    expect(result.strategiesEvaluated).toEqual(['MOMENTUM_BREAKOUT', 'MEAN_REVERSION']);
    expect(fastLaneManager.getCandidate(c.id)!.state).toBe('ACTIONABLE');
  });

  it('candidate + no strategy clears triggerMet -> NO_VALID_SETUP (the real PTC control case: a catalyst alone is not automatically a technical trigger)', async () => {
    const c = inject('PTCXX');
    vi.spyOn(quantSignalAgent, 'evaluateSymbol').mockResolvedValue(fakeEvaluation([
      { strategy: 'MOMENTUM_BREAKOUT', side: 'BUY', triggerMet: false, confidence: 0.3 },
      { strategy: 'TREND_FOLLOWING', side: 'BUY', triggerMet: false, confidence: 0.2 },
    ]) as any);
    const result = await evaluateFastCandidate(c.id);
    expect(result.status).toBe('NO_VALID_SETUP');
    expect(result.validTriggers).toEqual([]);
    expect(fastLaneManager.getCandidate(c.id)!.state).toBe('NO_SETUP');
  });

  it('expired candidate -> EXPIRED, never evaluated (no stale momentum resurrection)', async () => {
    const c = inject('CCCCC', 1); // 1ms TTL
    await new Promise((r) => setTimeout(r, 5));
    const spy = vi.spyOn(quantSignalAgent, 'evaluateSymbol');
    const result = await evaluateFastCandidate(c.id);
    expect(result.status).toBe('EXPIRED');
    expect(spy).not.toHaveBeenCalled(); // never reached real evaluation at all
  });

  it('provider failure (evaluateSymbol throws) -> explicit ERROR status, never a fabricated verdict', async () => {
    const c = inject('DDDDD');
    vi.spyOn(quantSignalAgent, 'evaluateSymbol').mockRejectedValue(new Error('provider down'));
    const result = await evaluateFastCandidate(c.id);
    expect(result.status).toBe('ERROR');
    expect(result.reasonCodes).toContain('EVALUATION_THREW');
    expect(result.bestStrategy).toBeUndefined();
  });

  it('duplicate concurrent calls for the SAME candidate/symbol coalesce onto one evaluation, never running the real strategy pipeline twice', async () => {
    const c = inject('EEEEE');
    const spy = vi.spyOn(quantSignalAgent, 'evaluateSymbol').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return fakeEvaluation([{ strategy: 'MOMENTUM_BREAKOUT', side: 'BUY', triggerMet: true, confidence: 0.8 }]) as any;
    });
    const [r1, r2, r3] = await Promise.all([
      evaluateFastCandidate(c.id),
      evaluateFastCandidate(c.id),
      evaluateFastCandidate(c.id),
    ]);
    expect(spy).toHaveBeenCalledTimes(1); // real evaluation ran exactly once, not three times
    expect(r1.status).toBe('VALID_STRATEGY_EVIDENCE');
    expect(r2).toEqual(r1);
    expect(r3).toEqual(r1);
  });

  it('bounded concurrency: refuses a new evaluation once fastLaneMaxConcurrentEvaluations is reached, rather than flooding the bar provider', async () => {
    const originalMax = tradingSafety.fastLaneMaxConcurrentEvaluations;
    (tradingSafety as any).fastLaneMaxConcurrentEvaluations = 1;
    try {
      const slow = inject('FFFFF');
      const overflow = inject('GGGGG');
      vi.spyOn(quantSignalAgent, 'evaluateSymbol').mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 30));
        return fakeEvaluation([{ strategy: 'MOMENTUM_BREAKOUT', side: 'BUY', triggerMet: true, confidence: 0.8 }]) as any;
      });
      const slowPromise = evaluateFastCandidate(slow.id);
      await new Promise((r) => setTimeout(r, 5)); // let the first evaluation actually start
      expect(fastLaneActiveEvaluationCountForTests()).toBe(1);
      const overflowResult = await evaluateFastCandidate(overflow.id);
      expect(overflowResult.reasonCodes).toContain('MAX_CONCURRENT_EVALUATIONS_REACHED');
      await slowPromise;
    } finally {
      (tradingSafety as any).fastLaneMaxConcurrentEvaluations = originalMax;
    }
  });

  it('per-symbol cooldown: re-evaluating the same symbol before fastLaneSymbolEvaluationCooldownMs elapses is refused, not silently re-run', async () => {
    const originalCooldown = tradingSafety.fastLaneSymbolEvaluationCooldownMs;
    (tradingSafety as any).fastLaneSymbolEvaluationCooldownMs = 10_000;
    try {
      const c1 = inject('HHHHH');
      vi.spyOn(quantSignalAgent, 'evaluateSymbol').mockResolvedValue(
        fakeEvaluation([{ strategy: 'MOMENTUM_BREAKOUT', side: 'BUY', triggerMet: true, confidence: 0.8 }]) as any,
      );
      await evaluateFastCandidate(c1.id); // completes, populates the HHHHH cooldown timestamp
      const result = await evaluateFastCandidate(c1.id); // same candidate, immediately again
      expect(result.reasonCodes).toContain('SYMBOL_EVALUATION_COOLDOWN_ACTIVE');
    } finally {
      (tradingSafety as any).fastLaneSymbolEvaluationCooldownMs = originalCooldown;
    }
  });

  it('D1: fast-lane evaluations are evaluation-only - evaluateSymbol is always called with emitIdeas:false', async () => {
    const c = inject('IIIII');
    const spy = vi.spyOn(quantSignalAgent, 'evaluateSymbol').mockResolvedValue(
      fakeEvaluation([{ strategy: 'MOMENTUM_BREAKOUT', side: 'BUY', triggerMet: true, confidence: 0.8 }]) as any,
    );
    await evaluateFastCandidate(c.id);
    expect(spy).toHaveBeenCalledWith('IIIII', { emitIdeas: false });
  });

  it('D4 (2026-10-09 P1 lease fix): a hung evaluation hits the watchdog - the caller is released, but the lease (slot + dedup) is HELD until the work settles', async () => {
    const originalTimeout = tradingSafety.fastLaneEvaluationTimeoutMs;
    (tradingSafety as any).fastLaneEvaluationTimeoutMs = 50;
    try {
      const c = inject('JJJJJ');
      // A promise that never settles - the pre-lease-fix D4 design released the slot on timeout,
      // which allowed invisible concurrency and duplicate replacement work for the same symbol.
      vi.spyOn(quantSignalAgent, 'evaluateSymbol').mockImplementation(() => new Promise(() => {}) as any);
      const result = await evaluateFastCandidate(c.id);
      expect(result.status).toBe('ERROR');
      expect(result.reasonCodes).toContain('EVALUATION_TIMEOUT');
      // Lease fix: the slot is HELD (never released on caller timeout) until the hung work
      // settles - the lane's capacity accounting stays honest about the still-running work.
      expect(fastLaneActiveEvaluationCountForTests()).toBe(1);
      const snapshot = getFastLaneLeaseSnapshot();
      expect(snapshot.activeLeaseCount).toBe(1);
      expect(snapshot.slotsHeld).toBe(1);
      expect(snapshot.leases[0].symbol).toBe('JJJJJ');
      expect(snapshot.leases[0].state).toBe('CALLER_TIMED_OUT');
      expect(snapshot.leases[0].slotHeld).toBe(true);
      // Candidate terminally transitioned to NO_SETUP with an honest reason (kept until its TTL
      // elapses per D2's bounded-retention rule, then swept).
      expect(fastLaneManager.getCandidate(c.id)?.state).toBe('NO_SETUP');
    } finally {
      (tradingSafety as any).fastLaneEvaluationTimeoutMs = originalTimeout;
    }
  });
});

describe('fastLaneEvaluator lease semantics (2026-10-09 P1 lease fix)', () => {
  const originalTimeout = tradingSafety.fastLaneEvaluationTimeoutMs;

  beforeEach(() => {
    (tradingSafety as any).fastLaneEvaluationTimeoutMs = 50;
  });

  afterEach(() => {
    (tradingSafety as any).fastLaneEvaluationTimeoutMs = originalTimeout;
  });

  it('caller timeout KEEPS the lease: slot count unchanged and dedup entry held until the work settles', async () => {
    const c = inject('KKKKK');
    vi.spyOn(quantSignalAgent, 'evaluateSymbol').mockImplementation(() => new Promise(() => {}) as any);
    const result = await evaluateFastCandidate(c.id);
    expect(result.status).toBe('ERROR');
    expect(result.reasonCodes).toContain('EVALUATION_TIMEOUT');
    // The caller got its bounded wait, but the lease was NOT released on timeout.
    expect(fastLaneActiveEvaluationCountForTests()).toBe(1);
    const snapshot = getFastLaneLeaseSnapshot();
    expect(snapshot.activeLeaseCount).toBe(1);
    expect(snapshot.slotsHeld).toBe(1);
    expect(snapshot.leases).toHaveLength(1);
    const lease = snapshot.leases[0];
    expect(lease.symbol).toBe('KKKKK');
    expect(lease.candidateId).toBe(c.id);
    expect(lease.generation).toBe(fastLaneEvaluatorGenerationForTests());
    expect(lease.acquiredAt).toBeLessThanOrEqual(Date.now());
    expect(lease.ageMs).toBeGreaterThanOrEqual(50); // waited the full caller budget
    expect(lease.state).toBe('CALLER_TIMED_OUT');
    expect(lease.slotHeld).toBe(true);
    expect(lease.timedOut).toBe(true);
    expect(snapshot.oldestLeaseAgeMs).toBe(lease.ageMs);
  });

  it('a replacement evaluation for the same symbol while the original is in flight (past caller timeout) is refused - never a second concurrent evaluation', async () => {
    const c1 = inject('LLLLL');
    const spy = vi.spyOn(quantSignalAgent, 'evaluateSymbol').mockImplementation(() => new Promise(() => {}) as any);
    const r1 = await evaluateFastCandidate(c1.id);
    expect(r1.reasonCodes).toContain('EVALUATION_TIMEOUT');
    expect(fastLaneActiveEvaluationCountForTests()).toBe(1);

    // The original work is still running (lease held in CALLER_TIMED_OUT). A replacement for
    // the same symbol must be refused via the dedup entry - the old D4 design would have
    // started a duplicate concurrent evaluation here.
    const c2 = inject('LLLLL');
    const r2 = await evaluateFastCandidate(c2.id);
    expect(r2.status).toBe('ERROR');
    expect(r2.reasonCodes).toContain('PRIOR_EVALUATION_STILL_IN_FLIGHT');
    expect(spy).toHaveBeenCalledTimes(1); // the real pipeline ran exactly once
    expect(fastLaneActiveEvaluationCountForTests()).toBe(1); // no phantom second slot
    // The refused candidate is left untouched (never reached evaluation).
    expect(fastLaneManager.getCandidate(c2.id)?.state).toBe('DETECTED');
  });

  it('late completion after caller timeout is discarded safely: no double transition, slot released on settle', async () => {
    const c = inject('MMMMM');
    let resolveEval!: (v: unknown) => void;
    vi.spyOn(quantSignalAgent, 'evaluateSymbol').mockImplementation(
      () => new Promise((res) => { resolveEval = res; }) as any,
    );
    const timeoutResult = await evaluateFastCandidate(c.id);
    expect(timeoutResult.reasonCodes).toContain('EVALUATION_TIMEOUT');
    expect(fastLaneManager.getCandidate(c.id)?.state).toBe('NO_SETUP');
    expect(fastLaneActiveEvaluationCountForTests()).toBe(1);

    // The late work settles with genuinely VALID evidence - without the authority guard this
    // would transition the candidate NO_SETUP -> ACTIONABLE (double-apply).
    resolveEval(fakeEvaluation([
      { strategy: 'MOMENTUM_BREAKOUT', side: 'BUY', triggerMet: true, confidence: 0.9 },
    ]));
    await new Promise((r) => setTimeout(r, 20)); // let the settle continuation run
    expect(fastLaneManager.getCandidate(c.id)?.state).toBe('NO_SETUP'); // discarded, not ACTIONABLE
    expect(fastLaneActiveEvaluationCountForTests()).toBe(0); // slot released on settle
    expect(getFastLaneLeaseSnapshot().activeLeaseCount).toBe(0); // dedup entry released
  });

  it('late rejection after caller timeout causes no unhandled rejection and releases the slot', async () => {
    const c = inject('NNNNN');
    let rejectEval!: (e: unknown) => void;
    vi.spyOn(quantSignalAgent, 'evaluateSymbol').mockImplementation(
      () => new Promise((_, rej) => { rejectEval = rej; }) as any,
    );
    const timeoutResult = await evaluateFastCandidate(c.id);
    expect(timeoutResult.reasonCodes).toContain('EVALUATION_TIMEOUT');
    expect(fastLaneActiveEvaluationCountForTests()).toBe(1);

    rejectEval(new Error('late provider failure'));
    await new Promise((r) => setTimeout(r, 20)); // let the settle continuation run
    expect(fastLaneActiveEvaluationCountForTests()).toBe(0);
    expect(getFastLaneLeaseSnapshot().activeLeaseCount).toBe(0);
    // vitest fails the run on unhandled rejections - reaching this line proves the late
    // rejection was absorbed by the lease settle path.
  });

  it('generation reset is safe: stale continuations and stale timers cannot corrupt new-generation state', async () => {
    const c1 = inject('OOOOO');
    let resolveFirst!: (v: unknown) => void;
    let calls = 0;
    vi.spyOn(quantSignalAgent, 'evaluateSymbol').mockImplementation(() => {
      calls += 1;
      if (calls === 1) return new Promise((res) => { resolveFirst = res; }) as any;
      return Promise.resolve(fakeEvaluation([
        { strategy: 'MOMENTUM_BREAKOUT', side: 'BUY', triggerMet: true, confidence: 0.8 },
      ])) as any;
    });
    const p1 = evaluateFastCandidate(c1.id); // starts, hangs
    await new Promise((r) => setTimeout(r, 10));

    const genBefore = fastLaneEvaluatorGenerationForTests();
    resetFastLaneEvaluatorForTests();
    expect(fastLaneEvaluatorGenerationForTests()).toBe(genBefore + 1);
    expect(fastLaneActiveEvaluationCountForTests()).toBe(0);
    expect(getFastLaneLeaseSnapshot().activeLeaseCount).toBe(0);

    // Close the old candidate (manager-level) so the symbol can be re-injected; the EVALUATOR's
    // dedup entry was cleared by the reset - that is what this step proves.
    fastLaneManager.transitionState(c1.id, 'NO_SETUP', 'test: close old candidate');
    const historyLenAfterClose = fastLaneManager.getCandidate(c1.id)!.stateHistory.length;

    // The same symbol is immediately evaluable in the new generation - no stranded dedup entry.
    const c2 = inject('OOOOO')!;
    const r2 = await evaluateFastCandidate(c2.id);
    expect(r2.status).toBe('VALID_STRATEGY_EVIDENCE');
    expect(calls).toBe(2);
    expect(fastLaneActiveEvaluationCountForTests()).toBe(0);
    expect(fastLaneManager.getCandidate(c2.id)?.state).toBe('ACTIONABLE');

    // The old generation's hung work settles now: the stale continuation must not touch
    // new-generation counters, and the stale caller timer must not transition anything.
    resolveFirst(fakeEvaluation([
      { strategy: 'MOMENTUM_BREAKOUT', side: 'BUY', triggerMet: true, confidence: 0.9 },
    ]));
    const r1 = await p1;
    expect(r1.reasonCodes).toContain('LATE_SETTLE_DISCARDED');
    await new Promise((r) => setTimeout(r, 20));
    expect(fastLaneActiveEvaluationCountForTests()).toBe(0); // not driven negative
    expect(getFastLaneLeaseSnapshot().activeLeaseCount).toBe(0);
    expect(fastLaneManager.getCandidate(c2.id)?.state).toBe('ACTIONABLE'); // new-gen result intact
    // The stale timer fired but was a generation no-op: the old candidate's history is untouched.
    expect(fastLaneManager.getCandidate(c1.id)?.state).toBe('NO_SETUP');
    expect(fastLaneManager.getCandidate(c1.id)!.stateHistory.length).toBe(historyLenAfterClose);
  });

  it('reaper quarantines a lease by max age even without consecutive timeouts (T-ms backstop)', async () => {
    const origMaxAge = tradingSafety.fastLaneHungLeaseMaxAgeMs;
    const origMaxTimeouts = tradingSafety.fastLaneHungLeaseMaxConsecutiveTimeouts;
    (tradingSafety as any).fastLaneHungLeaseMaxAgeMs = 30;
    (tradingSafety as any).fastLaneHungLeaseMaxConsecutiveTimeouts = 100; // count trigger disabled
    try {
      const c = inject('TTTTT');
      vi.spyOn(quantSignalAgent, 'evaluateSymbol').mockImplementation(() => new Promise(() => {}) as any);
      const p = evaluateFastCandidate(c.id);
      await new Promise((r) => setTimeout(r, 45)); // past max age, before the caller watchdog
      reapHungFastLaneLeasesForTests();
      const snapshot = getFastLaneLeaseSnapshot();
      expect(snapshot.activeLeaseCount).toBe(1);
      expect(snapshot.leases[0].state).toBe('QUARANTINED');
      expect(snapshot.leases[0].slotHeld).toBe(false); // capacity recovered
      expect(fastLaneActiveEvaluationCountForTests()).toBe(0);
      // The caller's watchdog still resolves honestly, and the post-quarantine timeout must
      // not regress the lease state or touch the candidate.
      const r = await p;
      expect(r.reasonCodes).toContain('EVALUATION_TIMEOUT');
      expect(getFastLaneLeaseSnapshot().leases[0].state).toBe('QUARANTINED');
    } finally {
      (tradingSafety as any).fastLaneHungLeaseMaxAgeMs = origMaxAge;
      (tradingSafety as any).fastLaneHungLeaseMaxConsecutiveTimeouts = origMaxTimeouts;
    }
  });

  it('hung work: bounded capacity consumption, quarantine recovers capacity, no duplicate execution, late settle cannot double-apply', async () => {
    const origMax = tradingSafety.fastLaneMaxConcurrentEvaluations;
    const origMaxTimeouts = tradingSafety.fastLaneHungLeaseMaxConsecutiveTimeouts;
    const origCooldown = tradingSafety.fastLaneSymbolEvaluationCooldownMs;
    (tradingSafety as any).fastLaneMaxConcurrentEvaluations = 1;
    (tradingSafety as any).fastLaneHungLeaseMaxConsecutiveTimeouts = 2;
    (tradingSafety as any).fastLaneSymbolEvaluationCooldownMs = 0; // isolate lease behavior from cooldown
    const hungResolvers: Array<(v: unknown) => void> = [];
    const spy = vi.spyOn(quantSignalAgent, 'evaluateSymbol').mockImplementation(((symbol: string) => {
      if (symbol === 'PPPPP') return new Promise((res) => { hungResolvers.push(res); }) as any;
      return Promise.resolve(fakeEvaluation([
        { strategy: 'MOMENTUM_BREAKOUT', side: 'BUY', triggerMet: true, confidence: 0.8 },
      ])) as any;
    }) as any);
    try {
      // 1. Hung work consumes exactly its bounded share of capacity - slot honestly held.
      const hung1 = inject('PPPPP')!;
      const rHung1 = await evaluateFastCandidate(hung1.id);
      expect(rHung1.reasonCodes).toContain('EVALUATION_TIMEOUT');
      expect(fastLaneActiveEvaluationCountForTests()).toBe(1);
      expect(getFastLaneLeaseSnapshot().leases[0].state).toBe('CALLER_TIMED_OUT');

      // 2. While hung (1 consecutive timeout < 2, no quarantine yet), a different symbol is
      //    refused - capacity honestly consumed, never silently exceeded.
      const other = inject('SSSSS')!;
      const rOther = await evaluateFastCandidate(other.id);
      expect(rOther.reasonCodes).toContain('MAX_CONCURRENT_EVALUATIONS_REACHED');
      expect(spy).not.toHaveBeenCalledWith('SSSSS', expect.anything());

      // 3. The first hung evaluation's work settles late: discarded, lease released, but the
      //    consecutive-timeout count for the symbol is kept (the timeout was real).
      hungResolvers[0](fakeEvaluation([
        { strategy: 'MOMENTUM_BREAKOUT', side: 'BUY', triggerMet: true, confidence: 0.95 },
      ]));
      await new Promise((r) => setTimeout(r, 20));
      expect(fastLaneManager.getCandidate(hung1.id)?.state).toBe('NO_SETUP'); // never ACTIONABLE
      expect(fastLaneActiveEvaluationCountForTests()).toBe(0);

      // 4. Second consecutive timeout for the same symbol (2 >= 2).
      const hung2 = inject('PPPPP')!;
      const rHung2 = await evaluateFastCandidate(hung2.id);
      expect(rHung2.reasonCodes).toContain('EVALUATION_TIMEOUT');
      expect(spy).toHaveBeenCalledTimes(2); // exactly one evaluation per attempt, never duplicated
      expect(fastLaneActiveEvaluationCountForTests()).toBe(1);

      // 5. The next admission attempt runs the reaper: 2 consecutive timeouts >= 2 -> QUARANTINE.
      //    The slot is returned to the pool (capacity recovers); the dedup entry is kept.
      const third = inject('RRRRR')!;
      const rThird = await evaluateFastCandidate(third.id);
      expect(rThird.status).toBe('VALID_STRATEGY_EVIDENCE'); // admitted and evaluated normally
      expect(spy).toHaveBeenCalledTimes(3); // PPPPP x2, RRRRR x1 - no duplicate execution
      const quarantined = getFastLaneLeaseSnapshot().leases.find((l) => l.symbol === 'PPPPP');
      expect(quarantined?.state).toBe('QUARANTINED');
      expect(quarantined?.slotHeld).toBe(false);
      expect(fastLaneActiveEvaluationCountForTests()).toBe(0);

      // 6. A replacement evaluation for the quarantined symbol is refused - quarantine can never
      //    create duplicate concurrent work for the same symbol.
      const hung3 = inject('PPPPP')!;
      const rHung3 = await evaluateFastCandidate(hung3.id);
      expect(rHung3.reasonCodes).toContain('FAST_LANE_SYMBOL_QUARANTINED');
      expect(spy).toHaveBeenCalledTimes(3);

      // 7. The second hung work finally settles with valid evidence: discarded, never double-applied.
      hungResolvers[1](fakeEvaluation([
        { strategy: 'MOMENTUM_BREAKOUT', side: 'BUY', triggerMet: true, confidence: 0.95 },
      ]));
      await new Promise((r) => setTimeout(r, 20));
      expect(fastLaneManager.getCandidate(hung2.id)?.state).toBe('NO_SETUP'); // timeout verdict stands
      expect(spy).toHaveBeenCalledTimes(3);
      expect(getFastLaneLeaseSnapshot().activeLeaseCount).toBe(0);
      expect(fastLaneActiveEvaluationCountForTests()).toBe(0);

      // 8. Capacity is eventually recoverable for the symbol too: once the hung work settled,
      //    the dedup entry is gone and a fresh evaluation is admitted (exactly one new run).
      //    (The step-6 candidate was refused before evaluation, so close it at the manager
      //    level to allow re-injection - manager dedup is orthogonal to the lease book.)
      fastLaneManager.transitionState(hung3.id, 'NO_SETUP', 'test: refused candidate closed');
      const hung4 = inject('PPPPP')!;
      const rHung4 = await evaluateFastCandidate(hung4.id);
      expect(rHung4.reasonCodes).toContain('EVALUATION_TIMEOUT'); // hangs again, caller bounded
      expect(spy).toHaveBeenCalledTimes(4);
      expect(fastLaneActiveEvaluationCountForTests()).toBe(1); // new lease honestly held
    } finally {
      (tradingSafety as any).fastLaneMaxConcurrentEvaluations = origMax;
      (tradingSafety as any).fastLaneHungLeaseMaxConsecutiveTimeouts = origMaxTimeouts;
      (tradingSafety as any).fastLaneSymbolEvaluationCooldownMs = origCooldown;
    }
  });
});
