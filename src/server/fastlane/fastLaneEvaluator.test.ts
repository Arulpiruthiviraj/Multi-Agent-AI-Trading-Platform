import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fastLaneManager } from './FastLaneManager';
import { quantSignalAgent } from '../services/QuantSignalAgent';
import {
  evaluateFastCandidate,
  resetFastLaneEvaluatorForTests,
  fastLaneActiveEvaluationCountForTests,
  getFastLaneEvaluatorDiagnostics,
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

  it('a timeout must retain the governor slot until the underlying work really settles', async () => {
    const originalTimeout = tradingSafety.fastLaneEvaluationTimeoutMs;
    const originalMax = tradingSafety.fastLaneMaxConcurrentEvaluations;
    (tradingSafety as any).fastLaneEvaluationTimeoutMs = 20;
    (tradingSafety as any).fastLaneMaxConcurrentEvaluations = 1;
    let finish!: (value: null) => void;
    const underlying = new Promise<null>(resolve => { finish = resolve; });
    try {
      const first = inject('LEASE');
      const next = inject('NEXT');
      const spy = vi.spyOn(quantSignalAgent, 'evaluateSymbol').mockImplementation(() => underlying);
      const result = await evaluateFastCandidate(first.id);
      expect(result.reasonCodes).toContain('EVALUATION_TIMEOUT');
      expect(fastLaneActiveEvaluationCountForTests()).toBe(1);
      expect(getFastLaneEvaluatorDiagnostics().inFlight).toEqual([{ symbol: 'LEASE', state: 'AWAITING_WORK_SETTLEMENT' }]);
      expect((await evaluateFastCandidate(first.id)).reasonCodes).toContain('SYMBOL_EVALUATION_STILL_RUNNING');
      const refused = await evaluateFastCandidate(next.id);
      expect(refused.reasonCodes).toContain('MAX_CONCURRENT_EVALUATIONS_REACHED');
      expect(spy).toHaveBeenCalledTimes(1);
      finish(null);
      await underlying;
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(fastLaneActiveEvaluationCountForTests()).toBe(0);
      expect(fastLaneManager.getCandidate(first.id)?.state).toBe('NO_SETUP');
      spy.mockResolvedValue(null);
      await evaluateFastCandidate(next.id);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      finish(null);
      (tradingSafety as any).fastLaneEvaluationTimeoutMs = originalTimeout;
      (tradingSafety as any).fastLaneMaxConcurrentEvaluations = originalMax;
    }
  });

  it('a late rejection releases exactly one retained lease without reviving a timed-out candidate', async () => {
    const originalTimeout = tradingSafety.fastLaneEvaluationTimeoutMs;
    (tradingSafety as any).fastLaneEvaluationTimeoutMs = 20;
    let reject!: (reason: Error) => void;
    const underlying = new Promise<null>((_, fail) => { reject = fail; });
    try {
      const c = inject('REJCT');
      vi.spyOn(quantSignalAgent, 'evaluateSymbol').mockImplementation(() => underlying);
      expect((await evaluateFastCandidate(c.id)).reasonCodes).toContain('EVALUATION_TIMEOUT');
      expect(fastLaneActiveEvaluationCountForTests()).toBe(1);
      reject(new Error('late provider failure'));
      await underlying.catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(fastLaneActiveEvaluationCountForTests()).toBe(0);
      expect(getFastLaneEvaluatorDiagnostics().inFlight).toEqual([]);
      expect(fastLaneManager.getCandidate(c.id)?.state).toBe('NO_SETUP');
    } finally {
      reject(new Error('cleanup'));
      (tradingSafety as any).fastLaneEvaluationTimeoutMs = originalTimeout;
    }
  });

  it('an old completion after reset cannot release a newer same-symbol lease', async () => {
    const originalTimeout = tradingSafety.fastLaneEvaluationTimeoutMs;
    (tradingSafety as any).fastLaneEvaluationTimeoutMs = 20;
    let finishOld!: (value: null) => void;
    let finishNew!: (value: null) => void;
    const oldWork = new Promise<null>(resolve => { finishOld = resolve; });
    const newWork = new Promise<null>(resolve => { finishNew = resolve; });
    try {
      const c = inject('RESET');
      vi.spyOn(quantSignalAgent, 'evaluateSymbol').mockImplementationOnce(() => oldWork).mockImplementationOnce(() => newWork);
      expect((await evaluateFastCandidate(c.id)).reasonCodes).toContain('EVALUATION_TIMEOUT');
      resetFastLaneEvaluatorForTests();
      const response = evaluateFastCandidate(c.id);
      await Promise.resolve();
      finishOld(null);
      await oldWork;
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(fastLaneActiveEvaluationCountForTests()).toBe(1);
      expect(getFastLaneEvaluatorDiagnostics().inFlight[0]?.symbol).toBe('RESET');
      finishNew(null);
      await response;
      expect(fastLaneActiveEvaluationCountForTests()).toBe(0);
    } finally {
      finishOld(null);
      finishNew(null);
      (tradingSafety as any).fastLaneEvaluationTimeoutMs = originalTimeout;
    }
  });

  it('acquires capacity before a synchronous provider callback can reenter admission', async () => {
    const originalMax = tradingSafety.fastLaneMaxConcurrentEvaluations;
    (tradingSafety as any).fastLaneMaxConcurrentEvaluations = 1;
    try {
      const first = inject('OWNER');
      const second = inject('OTHER');
      let reentered!: Promise<any>;
      const spy = vi.spyOn(quantSignalAgent, 'evaluateSymbol').mockImplementation(() => {
        expect(fastLaneActiveEvaluationCountForTests()).toBe(1);
        reentered = evaluateFastCandidate(second.id);
        return Promise.resolve(null);
      });
      await evaluateFastCandidate(first.id);
      expect((await reentered).reasonCodes).toContain('MAX_CONCURRENT_EVALUATIONS_REACHED');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(fastLaneActiveEvaluationCountForTests()).toBe(0);
    } finally {
      (tradingSafety as any).fastLaneMaxConcurrentEvaluations = originalMax;
    }
  });

  it('D4: a hung evaluation times out for the caller without pretending to cancel work', async () => {
    const originalTimeout = tradingSafety.fastLaneEvaluationTimeoutMs;
    (tradingSafety as any).fastLaneEvaluationTimeoutMs = 50;
    try {
      const c = inject('JJJJJ');
      // Never-settling work stays counted until genuine cancellation or settlement.
      vi.spyOn(quantSignalAgent, 'evaluateSymbol').mockImplementation(() => new Promise(() => {}) as any);
      const result = await evaluateFastCandidate(c.id);
      expect(result.status).toBe('ERROR');
      expect(result.reasonCodes).toContain('EVALUATION_TIMEOUT');
      expect(fastLaneActiveEvaluationCountForTests()).toBe(1);
      // Candidate terminally transitioned to NO_SETUP with an honest reason (kept until its TTL
      // elapses per D2's bounded-retention rule, then swept).
      expect(fastLaneManager.getCandidate(c.id)?.state).toBe('NO_SETUP');
    } finally {
      (tradingSafety as any).fastLaneEvaluationTimeoutMs = originalTimeout;
    }
  });
});
