// LABEL: UNIT
/**
 * ==========================================================
 * quantPriorityScheduler.test.ts — unit tests for the bounded priority quant
 * scheduler (src/server/scheduling/quantPriorityScheduler.ts).
 *
 * What these tests prove (scheduling only, never alpha):
 * - Priority affects WHEN a candidate is evaluated (P0 jumps queued P2/P3 work at
 *   slot handoff), never any gate outcome.
 * - Data acquisition never holds a quant compute slot (a slow provider fetch for
 *   symbol A cannot stall B/C/D).
 * - Singleflight dedup on symbol+fingerprint (incl. the fast-lane coordination
 *   contract via registerExternalEvaluation).
 * - Per-priority deadlines -> ASSESSMENT_EXPIRED, never a late evaluation
 *   pretending to be current.
 * - Queue overflow -> explicit EVICTED (preemption), never a silent drop.
 * - Every admitted candidate reaches exactly one terminal state (invariant under
 *   load with mixed fates).
 * - The user-endorsed SLA (HIGH admission->start <=30s p95 / ->complete <=60s p95;
 *   NORMAL <=60s / <=120s p95) holds under load. SLA numbers are read from
 *   config/tradingSafety.json via the same tradingSafety object production loads
 *   (repo AGENTS.md: tests must never hardcode a config number).
 * - Per-stage instrumentation is complete and ordered on every terminal outcome.
 *
 * The stub evaluator NEVER asserts BUY or any trading outcome - it returns a dummy
 * non-null value (ASSESSED) or null (INSUFFICIENT_BARS path). These tests assert on
 * SCHEDULING: ordering, boundedness, and terminal-state coverage.
 * ==========================================================
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  QuantPriorityScheduler,
  QuantCandidatePriority,
  priorityClassOf,
  resolveQuantSchedulerConfig,
  runQuantSchedulerBatch,
  type AdmissionResult,
  type QuantSchedulerDeps,
  type QuantSchedulerConfig,
  type QuantSchedulerCandidate,
  type CandidateOutcome,
  type SchedulerBar,
} from './quantPriorityScheduler';
import { tradingSafety } from '../config/tradingSafety';

/** AdmissionResult minus the external-dedup variant (the harness helper rejects those). */
type OwnedAdmission = Exclude<AdmissionResult, { externalInFlight: true }>;

const DAY_MS = 86_400_000;
const P0 = QuantCandidatePriority.P0_URGENT_MOVER;
const P1 = QuantCandidatePriority.P1_PROMOTED;
const P2 = QuantCandidatePriority.P2_NORMAL;
const P3 = QuantCandidatePriority.P3_BACKGROUND;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type FetchBehavior = 'ok' | 'throw429' | 'throwOther' | 'hang';

interface Harness {
  scheduler: QuantPriorityScheduler;
  /** Admit with the scheduler-owned outcome type (throws if the admission coalesced
   *  onto an external evaluation - tests that need the raw union use scheduler.admit). */
  admit: (candidate: QuantSchedulerCandidate) => OwnedAdmission;
  events: Array<{ type: string; fields: Record<string, unknown> }>;
  evaluatedSymbols: string[];
  evaluateCallsBySymbol: Map<string, number>;
  ensureCalls: string[];
  seedBars: (symbol: string, count: number, newestAgeMs: number) => void;
  setFetchBehavior: (symbol: string, b: FetchBehavior) => void;
  setFetchDelayMs: (ms: number) => void;
  setRefreshDelivers: (symbol: string, delivers: boolean) => void;
  setEvaluatorDelay: (ms: number | ((symbol: string) => number)) => void;
  setEvaluatorHangs: (symbol: string) => void;
  setEvaluatorThrows: (symbol: string, message: string) => void;
  setEvaluatorReturnsNull: (symbol: string) => void;
  setExpectedBarCountOverride: (n: number | null) => void;
  setRateLimitedUntilMs: (ms: number) => void;
  setProviderRateLimitedThrows: () => void;
  terminalEvents: () => Array<{ type: string; fields: Record<string, unknown> }>;
  maxConcurrentEvals: () => number;
}

/** Fully in-memory scheduler under test: stub evaluator, stub bar gateway. */
function makeHarness(config?: Partial<QuantSchedulerConfig>): Harness {
  const events: Array<{ type: string; fields: Record<string, unknown> }> = [];
  const evaluatedSymbols: string[] = [];
  const evaluateCallsBySymbol = new Map<string, number>();
  const ensureCalls: string[] = [];
  const barsBySymbol = new Map<string, SchedulerBar[]>();
  const fetchBehavior = new Map<string, FetchBehavior>();
  const refreshDelivers = new Map<string, boolean>();
  const evaluatorThrows = new Map<string, string>();
  const evaluatorReturnsNull = new Set<string>();
  const evaluatorHangs = new Set<string>();
  let evaluateDelay: number | ((symbol: string) => number) = 0;
  let fetchDelayMs = 0;
  let rateLimitedUntilMs = 0;
  let rateLimitedThrows = false;
  let expectedBarCountOverride: number | null = null;
  let concurrentEvals = 0;
  let maxConcurrent = 0;

  const seedBars = (symbol: string, count: number, newestAgeMs: number): void => {
    const now = Date.now();
    const bars: SchedulerBar[] = [];
    for (let i = count - 1; i >= 0; i--) {
      bars.push({ timestamp: now - newestAgeMs - i * DAY_MS });
    }
    barsBySymbol.set(symbol.toUpperCase(), bars);
  };

  const deps: QuantSchedulerDeps = {
    evaluateSymbol: async (symbol: string) => {
      const key = symbol.toUpperCase();
      evaluatedSymbols.push(symbol);
      evaluateCallsBySymbol.set(key, (evaluateCallsBySymbol.get(key) ?? 0) + 1);
      concurrentEvals += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrentEvals);
      try {
        const d = typeof evaluateDelay === 'function' ? evaluateDelay(symbol) : evaluateDelay;
        if (d > 0) await sleep(d);
        if (evaluatorHangs.has(key)) await new Promise<void>(() => {}); // never settles
        const throwMsg = evaluatorThrows.get(key);
        if (throwMsg !== undefined) throw new Error(throwMsg);
        return evaluatorReturnsNull.has(key) ? null : { symbol, stubEvaluation: true };
      } finally {
        concurrentEvals -= 1;
      }
    },
    getBars: async (symbol: string) => [...(barsBySymbol.get(symbol.toUpperCase()) ?? [])],
    expectedBarCount: (_timeframe: string, startMs: number, endMs: number) =>
      expectedBarCountOverride ?? Math.max(1, Math.round((endMs - startMs) / DAY_MS)),
    ensureBars: async (symbol: string) => {
      const key = symbol.toUpperCase();
      ensureCalls.push(symbol);
      if (fetchDelayMs > 0) await sleep(fetchDelayMs);
      const b = fetchBehavior.get(key) ?? 'ok';
      if (b === 'hang') await new Promise<void>(() => {});
      if (b === 'throw429') throw new Error('429 Too Many Requests (test fault injection)');
      if (b === 'throwOther') throw new Error('provider exploded (test fault injection)');
      // 'ok': a per-policy fetch delivers fresh bars unless the test says otherwise.
      if (refreshDelivers.get(key) !== false) seedBars(symbol, 400, 30 * 60_000);
    },
    providerRateLimitedUntilMs: () => {
      if (rateLimitedThrows) throw new Error('rate-limit clock exploded (test fault injection)');
      return rateLimitedUntilMs;
    },
    minBars: 60,
    lookbackDays: 400,
    config,
    emit: (type, fields) => events.push({ type, fields }),
  };

  const scheduler = new QuantPriorityScheduler(deps);
  scheduler.start();
  return {
    scheduler,
    admit: (candidate: QuantSchedulerCandidate): OwnedAdmission => {
      const a = scheduler.admit(candidate);
      if ('externalInFlight' in a) throw new Error('test admission unexpectedly coalesced onto an external evaluation');
      return a;
    },
    events,
    evaluatedSymbols,
    evaluateCallsBySymbol,
    ensureCalls,
    seedBars,
    setFetchBehavior: (s, b) => fetchBehavior.set(s.toUpperCase(), b),
    setFetchDelayMs: (ms) => {
      fetchDelayMs = ms;
    },
    setRefreshDelivers: (s, d) => refreshDelivers.set(s.toUpperCase(), d),
    setEvaluatorDelay: (d) => {
      evaluateDelay = d;
    },
    setEvaluatorHangs: (s) => evaluatorHangs.add(s.toUpperCase()),
    setEvaluatorThrows: (s, m) => evaluatorThrows.set(s.toUpperCase(), m),
    setEvaluatorReturnsNull: (s) => evaluatorReturnsNull.add(s.toUpperCase()),
    setExpectedBarCountOverride: (n) => {
      expectedBarCountOverride = n;
    },
    setProviderRateLimitedThrows: () => {
      rateLimitedThrows = true;
    },
    setRateLimitedUntilMs: (ms) => {
      rateLimitedUntilMs = ms;
    },
    terminalEvents: () => events.filter((e) => e.type === 'QUANT_SCHEDULER_CANDIDATE_TERMINAL'),
    maxConcurrentEvals: () => maxConcurrent,
  };
}

let harnesses: Harness[] = [];
function harness(config?: Partial<QuantSchedulerConfig>): Harness {
  const h = makeHarness(config);
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses) {
    try {
      h.scheduler.stop();
    } catch {
      /* never fail teardown */
    }
  }
  harnesses = [];
});

function p95(values: number[]): number {
  if (values.length === 0) throw new Error('p95 of empty set');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
}

describe('quantPriorityScheduler', () => {
  it('priority ordering: a P0 admitted mid-cycle jumps ahead of queued P2 work at slot handoff', async () => {
    const h = harness({ quantWorkerPoolSize: 1, dataFetchPoolSize: 4 });
    h.setEvaluatorDelay((sym) => (sym === 'P0M' ? 50 : 300));
    for (const s of ['P2A', 'P2B', 'P2C']) h.seedBars(s, 400, 30 * 60_000);

    // Busy cycle: three P2 evaluations occupy the single quant worker.
    const p2Outcomes = ['P2A', 'P2B', 'P2C'].map(
      (s) => h.admit({ symbol: s, priority: P2, source: 'CYCLE' }).outcome,
    );
    // Mid-cycle late admission: a high-priority mover with usable data.
    await sleep(100);
    h.seedBars('P0M', 400, 30 * 60_000);
    const p0Admission = h.admit({ symbol: 'P0M', priority: P0, source: 'MOVER' });
    expect(p0Admission.accepted).toBe(true);

    const [p2a, p2b, p2c] = await Promise.all(p2Outcomes);
    const p0 = await p0Admission.outcome;
    for (const o of [p2a, p2b, p2c, p0]) expect(o.terminalState).toBe('ASSESSED');

    // P0 started before the queued P2s despite being admitted last.
    const startOrder = [p2a, p2b, p2c, p0]
      .sort((a, b) => (a.stages.quantStartedAtMs ?? 0) - (b.stages.quantStartedAtMs ?? 0))
      .map((o) => o.symbol);
    expect(startOrder).toEqual(['P2A', 'P0M', 'P2B', 'P2C']);
    expect(p0.stages.quantStartedAtMs).toBeLessThan(p2b.stages.quantStartedAtMs ?? Infinity);
    // Bounded: far below the 60s HIGH_PRIORITY complete SLA (forensic p50 was 12.9 min).
    expect(p0.admissionToTerminalMs).toBeLessThan(10_000);
    expect(p0.admissionToTerminalMs).toBeLessThanOrEqual(
      tradingSafety.quantSchedulerHighPriorityAdmissionToCompleteSlaMs,
    );
  });

  it('data/compute separation: a slow provider fetch for A never holds a quant slot needed by B/C', async () => {
    const h = harness({ quantWorkerPoolSize: 2, dataFetchPoolSize: 2 });
    h.setEvaluatorDelay(100);
    h.setFetchDelayMs(500); // slow provider
    // SLOW starts with no usable data -> must take the data-fetch path.
    // FAST1/FAST2 have warm caches -> go straight to quant workers.
    h.seedBars('FAST1', 400, 30 * 60_000);
    h.seedBars('FAST2', 400, 30 * 60_000);

    const slow = h.admit({ symbol: 'SLOW', priority: P2, source: 'CYCLE' }).outcome;
    const fast1 = h.admit({ symbol: 'FAST1', priority: P2, source: 'CYCLE' }).outcome;
    const fast2 = h.admit({ symbol: 'FAST2', priority: P2, source: 'CYCLE' }).outcome;
    const [slowO, fast1O, fast2O] = await Promise.all([slow, fast1, fast2]);

    expect(slowO.terminalState).toBe('ASSESSED');
    expect(fast1O.terminalState).toBe('ASSESSED');
    expect(fast2O.terminalState).toBe('ASSESSED');
    // The slow fetch ran in the data-fetch stage (a data-fetch slot, never a quant slot).
    expect(slowO.stages.dataFetchStartedAtMs).not.toBeNull();
    expect(slowO.stages.dataFetchFinishedAtMs).not.toBeNull();
    // B and C completed their quant evaluations while A's fetch was still in flight.
    expect(fast1O.stages.quantStartedAtMs).toBeLessThan(slowO.stages.quantStartedAtMs ?? Infinity);
    expect(fast2O.stages.quantStartedAtMs).toBeLessThan(slowO.stages.quantStartedAtMs ?? Infinity);
    expect(fast1O.admissionToTerminalMs).toBeLessThan(slowO.admissionToTerminalMs);
    // The quant pool stayed bounded throughout.
    expect(h.maxConcurrentEvals()).toBeLessThanOrEqual(2);
  });

  it('singleflight: concurrent admissions for the same symbol+fingerprint coalesce onto one evaluation', async () => {
    const h = harness();
    h.seedBars('DUPE', 400, 30 * 60_000);
    h.setEvaluatorDelay(200);

    const a = h.admit({ symbol: 'DUPE', priority: P2, source: 'CYCLE' });
    const b = h.admit({ symbol: 'dupe', priority: P0, source: 'MOVER' }); // case-insensitive, higher priority
    expect(a.accepted).toBe(true);
    if (!a.accepted) throw new Error('unreachable');
    expect(a.deduped).toBe(false);
    expect(b.accepted).toBe(true);
    if (!b.accepted) throw new Error('unreachable');
    expect(b.deduped).toBe(true);
    expect(b.candidateId).toBe(a.candidateId);

    const [oa, ob] = await Promise.all([a.outcome, b.outcome]);
    expect(oa.terminalState).toBe('ASSESSED');
    expect(ob.terminalState).toBe('ASSESSED');
    expect(h.evaluateCallsBySymbol.get('DUPE')).toBe(1); // exactly one real evaluation

    // Re-admission inside the dedup window coalesces onto the remembered terminal outcome.
    const c = h.admit({ symbol: 'DUPE', priority: P2, source: 'CYCLE' });
    expect(c.accepted).toBe(true);
    if (!c.accepted) throw new Error('unreachable');
    expect(c.deduped).toBe(true);
    expect((await c.outcome).terminalState).toBe('ASSESSED');
    expect(h.evaluateCallsBySymbol.get('DUPE')).toBe(1);

    // A different fingerprint is a different evaluation (no false dedup).
    const d = h.admit({ symbol: 'DUPE', priority: P2, source: 'CYCLE', evaluationFingerprint: 'other-fp' });
    expect(d.accepted).toBe(true);
    if (!d.accepted) throw new Error('unreachable');
    expect(d.deduped).toBe(false);
    await d.outcome;
    expect(h.evaluateCallsBySymbol.get('DUPE')).toBe(2);
  });

  it('singleflight: the dedup window expires and a later admission re-evaluates', async () => {
    const h = harness({ dedupWindowMs: 200 });
    h.seedBars('RETRY', 400, 30 * 60_000);
    const a = h.admit({ symbol: 'RETRY', priority: P2, source: 'CYCLE' });
    expect((await a.outcome).terminalState).toBe('ASSESSED');
    expect(h.evaluateCallsBySymbol.get('RETRY')).toBe(1);
    await sleep(350); // past the 200ms dedup window
    const b = h.admit({ symbol: 'RETRY', priority: P2, source: 'CYCLE' });
    if (!b.accepted) throw new Error('unreachable');
    expect(b.deduped).toBe(false);
    expect((await b.outcome).terminalState).toBe('ASSESSED');
    expect(h.evaluateCallsBySymbol.get('RETRY')).toBe(2);
  });

  it('fast-lane coordination: a registered external evaluation is never duplicated by the scheduler', async () => {
    const h = harness();
    h.seedBars('EXT', 400, 30 * 60_000);
    let resolveExternal!: (v: unknown) => void;
    const externalDone = new Promise<unknown>((resolve) => {
      resolveExternal = resolve;
    });
    // Simulates Task B's held lease: the fast lane owns EXT until its work settles.
    const unregister = h.scheduler.registerExternalEvaluation('EXT', 'fastlane-fp', externalDone);

    const admission = h.scheduler.admit({
      symbol: 'EXT', priority: P0, source: 'MOVER', evaluationFingerprint: 'fastlane-fp',
    });
    expect('externalInFlight' in admission).toBe(true);
    if (!('externalInFlight' in admission)) throw new Error('expected external dedup');
    expect(admission.accepted).toBe(false);
    expect(admission.deduped).toBe(true);
    expect(h.evaluateCallsBySymbol.get('EXT') ?? 0).toBe(0); // no duplicate evaluation

    resolveExternal({ status: 'VALID_STRATEGY_EVIDENCE' });
    unregister();
    await sleep(50);
    // After the external lease is released, the scheduler evaluates normally.
    const second = h.scheduler.admit({
      symbol: 'EXT', priority: P0, source: 'MOVER', evaluationFingerprint: 'fastlane-fp',
    });
    if ('externalInFlight' in second) throw new Error('unexpected external dedup');
    expect(second.deduped).toBe(false);
    expect((await second.outcome).terminalState).toBe('ASSESSED');
    expect(h.evaluateCallsBySymbol.get('EXT')).toBe(1);
  });

  it('deadlines: a P3 past its deadline while queued transitions ASSESSMENT_EXPIRED', async () => {
    const h = harness({ quantWorkerPoolSize: 1, dataFetchPoolSize: 4, p3DeadlineMs: 400, sweepIntervalMs: 50 });
    h.seedBars('BLOCKER', 400, 30 * 60_000);
    h.seedBars('P3V', 400, 30 * 60_000);
    h.setEvaluatorDelay(800); // blocker holds the only quant slot

    const blocker = h.admit({ symbol: 'BLOCKER', priority: P2, source: 'CYCLE' }).outcome;
    const victim = h.admit({ symbol: 'P3V', priority: P3, source: 'BACKGROUND' }).outcome;
    await sleep(600); // past the 400ms P3 deadline
    h.scheduler.sweepForTests();

    const victimO = await victim;
    expect(victimO.terminalState).toBe('ASSESSMENT_EXPIRED');
    expect(victimO.reasonCode).toBe('PRIORITY_DEADLINE_EXCEEDED_WHILE_QUEUED');
    expect(victimO.evaluationSettledLate).toBe(false);
    // The blocker was unaffected and still assessed.
    expect((await blocker).terminalState).toBe('ASSESSED');
    // No evaluation was ever started for the expired candidate.
    expect(h.evaluateCallsBySymbol.get('P3V') ?? 0).toBe(0);
  });

  it('deadlines: an evaluation that settles after its deadline is ASSESSMENT_EXPIRED, never presented as current', async () => {
    const h = harness({ p2DeadlineMs: 300, sweepIntervalMs: 50 });
    h.seedBars('LATE', 400, 30 * 60_000);
    h.setEvaluatorDelay(800); // slower than the 300ms deadline

    const admission = h.admit({ symbol: 'LATE', priority: P2, source: 'CYCLE' });
    await sleep(500); // deadline passes mid-flight; the interval sweeper flags it
    h.scheduler.sweepForTests();
    const o = await admission.outcome;
    expect(o.terminalState).toBe('ASSESSMENT_EXPIRED');
    expect(o.reasonCode).toBe('EVALUATION_SETTLED_AFTER_DEADLINE');
    expect(o.evaluationSettledLate).toBe(true);
  });

  it('queue overflow: a P0 preempts the oldest parked lower-priority candidate (explicit EVICTED)', async () => {
    const h = harness({ quantWorkerPoolSize: 1, dataFetchPoolSize: 4, maxQueueDepth: 3 });
    h.setEvaluatorDelay(500); // nothing settles during the admission burst
    for (const s of ['P3A', 'P3B', 'P3C', 'P0X']) h.seedBars(s, 400, 30 * 60_000);

    const p3a = h.admit({ symbol: 'P3A', priority: P3, source: 'BACKGROUND' });
    await sleep(100); // P3A is now genuinely in flight, holding the only quant slot
    const p3b = h.admit({ symbol: 'P3B', priority: P3, source: 'BACKGROUND' });
    const p3c = h.admit({ symbol: 'P3C', priority: P3, source: 'BACKGROUND' });
    // Queue is now full (3 tracked). A P0 displaces lower-priority work - but prefers a
    // PARKED candidate over the in-flight P3A (evicting in-flight wastes partial work
    // without freeing its slot promptly).
    const p0x = h.admit({ symbol: 'P0X', priority: P0, source: 'MOVER' });
    expect(p0x.accepted).toBe(true);

    const [oa, ob, oc, ox] = await Promise.all([p3a.outcome, p3b.outcome, p3c.outcome, p0x.outcome]);
    const evicted = [oa, ob, oc].filter((o) => o.terminalState === 'EVICTED');
    expect(evicted).toHaveLength(1);
    expect(evicted[0].reasonCode).toBe('PREEMPTED_BY_HIGHER_PRIORITY');
    expect(evicted[0].symbol).toBe('P3B'); // oldest PARKED candidate; in-flight P3A spared
    expect(oa.terminalState).toBe('ASSESSED'); // the in-flight candidate completed normally
    expect(ox.terminalState).toBe('ASSESSED');
    // The P0 jumped ahead of the still-queued P3 (P3C) at slot handoff.
    expect(ox.stages.quantStartedAtMs).toBeLessThan(oc.stages.quantStartedAtMs ?? Infinity);
    // The evicted candidate never consumed a quant slot.
    expect(ob.stages.quantStartedAtMs).toBeNull();
  });

  it('queue overflow: admission rejected as EVICTED when the queue holds equal-or-higher priority work', async () => {
    const h = harness({ quantWorkerPoolSize: 1, dataFetchPoolSize: 4, maxQueueDepth: 2 });
    h.setEvaluatorDelay(500);
    for (const s of ['P0A', 'P0B', 'P0C']) h.seedBars(s, 400, 30 * 60_000);
    h.admit({ symbol: 'P0A', priority: P0, source: 'MOVER' });
    h.admit({ symbol: 'P0B', priority: P0, source: 'MOVER' });
    const rejected = h.admit({ symbol: 'P0C', priority: P0, source: 'MOVER' });
    expect('terminalState' in rejected).toBe(true);
    if (!('terminalState' in rejected)) throw new Error('expected immediate terminal');
    expect(rejected.terminalState).toBe('EVICTED');
    expect(rejected.reasonCode).toBe('QUEUE_FULL');
    const o = await rejected.outcome;
    expect(o.terminalState).toBe('EVICTED');
    // The rejection itself was observable (terminal event), never a silent drop.
    expect(h.terminalEvents().filter((e) => e.fields['symbol'] === 'P0C')).toHaveLength(1);
  });

  it('admission guards: NOT_ELIGIBLE before start, for invalid symbols, and after stop', async () => {
    const raw = new QuantPriorityScheduler({
      evaluateSymbol: async () => ({}),
      getBars: async () => [],
      ensureBars: async () => {},
      providerRateLimitedUntilMs: () => 0,
      minBars: 60,
      expectedBarCount: () => 400,
      lookbackDays: 400,
      emit: () => {},
    });
    // Not started.
    const notStarted = raw.admit({ symbol: 'AAA', priority: P2, source: 'CYCLE' });
    expect('terminalState' in notStarted).toBe(true);
    if (!('terminalState' in notStarted)) throw new Error('expected immediate terminal');
    expect(notStarted.terminalState).toBe('NOT_ELIGIBLE');
    expect(notStarted.reasonCode).toBe('SCHEDULER_NOT_RUNNING');

    raw.start();
    const invalid = raw.admit({ symbol: '!!!', priority: P2, source: 'CYCLE' });
    expect('terminalState' in invalid).toBe(true);
    if (!('terminalState' in invalid)) throw new Error('expected immediate terminal');
    expect(invalid.terminalState).toBe('NOT_ELIGIBLE');
    expect(invalid.reasonCode).toBe('INVALID_SYMBOL');

    raw.stop();
    const afterStop = raw.admit({ symbol: 'BBB', priority: P2, source: 'CYCLE' });
    expect('terminalState' in afterStop).toBe(true);
    if (!('terminalState' in afterStop)) throw new Error('expected immediate terminal');
    expect(afterStop.terminalState).toBe('NOT_ELIGIBLE');
  });

  it('invariant under load: 60 mixed-fate candidates each reach exactly one terminal state', async () => {
    const h = harness({ dataFetchTimeoutMs: 300 });
    // Fates: 40 clean, 5 fetch-then-ok, 5 provider-429, 3 fetch-hang, 3 fetch-ok-but-still-empty,
    // 2 evaluator-throw, 2 evaluator-null (insufficient bars at evaluation).
    const symbols: string[] = [];
    for (let i = 0; i < 40; i++) symbols.push(`OK${i}`);
    for (let i = 0; i < 5; i++) symbols.push(`FETCHOK${i}`);
    for (let i = 0; i < 5; i++) symbols.push(`BO${i}`);
    for (let i = 0; i < 3; i++) symbols.push(`HANG${i}`);
    for (let i = 0; i < 3; i++) symbols.push(`EMPTY${i}`);
    for (let i = 0; i < 2; i++) symbols.push(`THROW${i}`);
    for (let i = 0; i < 2; i++) symbols.push(`NULL${i}`);
    expect(symbols).toHaveLength(60);

    for (const s of symbols) {
      if (s.startsWith('OK')) h.seedBars(s, 400, 30 * 60_000);
      else if (s.startsWith('BO')) h.setFetchBehavior(s, 'throw429');
      else if (s.startsWith('HANG')) h.setFetchBehavior(s, 'hang');
      else if (s.startsWith('EMPTY')) h.setRefreshDelivers(s, false);
      else if (s.startsWith('THROW')) {
        h.seedBars(s, 400, 30 * 60_000);
        h.setEvaluatorThrows(s, 'kaboom (test)');
      } else if (s.startsWith('NULL')) {
        h.seedBars(s, 400, 30 * 60_000);
        h.setEvaluatorReturnsNull(s);
      }
      // FETCHOK: no seed -> fetch delivers fresh bars.
    }
    h.setEvaluatorDelay(10);

    const priorities = [P0, P1, P2, P3];
    const admissions = symbols.map((s, i) =>
      h.admit({ symbol: s, priority: priorities[i % 4], source: 'LOAD' }),
    );
    const outcomes = await Promise.all(admissions.map((a) => a.outcome));

    // Exactly one terminal state per candidate, from the known vocabulary.
    const validStates = new Set([
      'ASSESSED', 'DATA_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'PROVIDER_BACKOFF',
      'EXPIRED', 'EVICTED', 'NOT_ELIGIBLE', 'ERROR', 'ASSESSMENT_EXPIRED',
    ]);
    expect(outcomes).toHaveLength(60);
    const candidateIds = new Set<string>();
    for (const o of outcomes) {
      expect(validStates.has(o.terminalState)).toBe(true);
      expect(o.stages.terminalAtMs).not.toBeNull();
      candidateIds.add(o.candidateId);
    }
    expect(candidateIds.size).toBe(60); // no two candidates shared an outcome identity
    // Exactly one terminal observability event per candidate - nothing silent, nothing double.
    expect(h.terminalEvents()).toHaveLength(60);

    const byState = new Map<string, number>();
    for (const o of outcomes) byState.set(o.terminalState, (byState.get(o.terminalState) ?? 0) + 1);
    expect(byState.get('ASSESSED')).toBe(45); // 40 OK + 5 FETCHOK
    expect(byState.get('PROVIDER_BACKOFF')).toBe(5);
    expect(byState.get('PROVIDER_TIMEOUT')).toBe(3);
    expect(byState.get('DATA_UNAVAILABLE')).toBe(5); // 3 EMPTY + 2 NULL
    expect(byState.get('ERROR')).toBe(2);
  });

  it('provider backoff: an armed gateway rate-limit backoff resolves candidates honestly', async () => {
    const h = harness();
    h.seedBars('BL', 400, 30 * 60_000);
    h.setRateLimitedUntilMs(Date.now() + 60_000); // gateway backoff armed
    const o = await h.admit({ symbol: 'BL', priority: P1, source: 'CYCLE' }).outcome;
    expect(o.terminalState).toBe('PROVIDER_BACKOFF');
    expect(o.reasonCode).toBe('GATEWAY_RATE_LIMIT_BACKOFF_ARMED');
    expect(h.ensureCalls).toHaveLength(0); // never even attempted the doomed fetch
  });

  it('stage instrumentation: every terminal outcome carries complete, ordered stage timestamps', async () => {
    const h = harness();
    h.seedBars('INST', 400, 30 * 60_000);
    h.setEvaluatorDelay(20);
    const o = await h.admit({ symbol: 'INST', priority: P1, source: 'CYCLE' }).outcome;
    expect(o.terminalState).toBe('ASSESSED');
    const s = o.stages;
    const ordered = [
      s.admittedAtMs, s.queuedAtMs, s.dataReadinessCheckedAtMs, s.dataFetchStartedAtMs,
      s.dataFetchFinishedAtMs, s.quantStartedAtMs, s.quantFinishedAtMs, s.terminalAtMs,
    ];
    for (const t of ordered) expect(t).not.toBeNull();
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i] as number).toBeGreaterThanOrEqual(ordered[i - 1] as number);
    }
    // Java bridge fields are honestly null (owned by QuantCoreBridge, not the scheduler).
    expect(s.javaStartedAtMs).toBeNull();
    expect(s.javaFinishedAtMs).toBeNull();
    expect(o.admissionToQuantStartMs).not.toBeNull();
    expect(o.admissionToTerminalMs).toBeGreaterThanOrEqual(o.admissionToQuantStartMs ?? 0);
    // The terminal event carries the full attribution payload.
    const terminalEvent = h.terminalEvents().find((e) => e.fields['symbol'] === 'INST');
    expect(terminalEvent).toBeTruthy();
    for (const k of ['admittedAtMs', 'dataFetchStartedAtMs', 'quantStartedAtMs', 'terminalAtMs', 'admissionToTerminalMs']) {
      expect(terminalEvent?.fields[k]).not.toBeNull();
    }
  });

  it('priority classes: P0/P1 are HIGH, P2 NORMAL, P3 BACKGROUND', () => {
    expect(priorityClassOf(P0)).toBe('HIGH');
    expect(priorityClassOf(P1)).toBe('HIGH');
    expect(priorityClassOf(P2)).toBe('NORMAL');
    expect(priorityClassOf(P3)).toBe('BACKGROUND');
  });

  it('SLA: p95 admission->start and admission->complete meet the user-endorsed targets under load', async () => {
    // Real production config - no overrides. SLA numbers come from the same
    // tradingSafety object production loads (repo AGENTS.md).
    const h = harness();
    const cfg = resolveQuantSchedulerConfig();
    expect(cfg.quantWorkerPoolSize).toBe(tradingSafety.quantSchedulerQuantWorkerPoolSize);
    h.setEvaluatorDelay(() => 5 + Math.random() * 15);
    for (let i = 0; i < 80; i++) h.seedBars(`SLA${i}`, 400, 30 * 60_000);

    const admissions: Array<{ outcome: Promise<CandidateOutcome>; cls: 'HIGH' | 'NORMAL' }> = [];
    for (let i = 0; i < 40; i++) {
      const p = i % 2 === 0 ? P0 : P1;
      const a = h.admit({ symbol: `SLA${i}`, priority: p, source: 'SLA' });
      admissions.push({ outcome: a.outcome, cls: 'HIGH' });
    }
    for (let i = 40; i < 80; i++) {
      const a = h.admit({ symbol: `SLA${i}`, priority: P2, source: 'SLA' });
      admissions.push({ outcome: a.outcome, cls: 'NORMAL' });
    }
    const outcomes = await Promise.all(admissions.map((a) => a.outcome));
    expect(outcomes).toHaveLength(80);
    for (const o of outcomes) expect(o.terminalState).toBe('ASSESSED');

    const startsHigh: number[] = [];
    const completesHigh: number[] = [];
    const startsNormal: number[] = [];
    const completesNormal: number[] = [];
    outcomes.forEach((o, i) => {
      const target = admissions[i].cls === 'HIGH'
        ? { s: startsHigh, c: completesHigh }
        : { s: startsNormal, c: completesNormal };
      target.s.push(o.admissionToQuantStartMs ?? -1);
      target.c.push(o.admissionToTerminalMs);
    });
    for (const v of [...startsHigh, ...startsNormal]) expect(v).toBeGreaterThanOrEqual(0);

    expect(p95(startsHigh)).toBeLessThanOrEqual(tradingSafety.quantSchedulerHighPriorityAdmissionToStartSlaMs);
    expect(p95(completesHigh)).toBeLessThanOrEqual(tradingSafety.quantSchedulerHighPriorityAdmissionToCompleteSlaMs);
    expect(p95(startsNormal)).toBeLessThanOrEqual(tradingSafety.quantSchedulerNormalAdmissionToStartSlaMs);
    expect(p95(completesNormal)).toBeLessThanOrEqual(tradingSafety.quantSchedulerNormalAdmissionToCompleteSlaMs);
  });

  it('feature flag: the priority scheduler is opt-in (safe default off)', () => {
    // The module-level helper reads the env var named by the config key; default off.
    expect(tradingSafety.quantPrioritySchedulerEnabledEnvVar).toBe('QUANT_PRIORITY_SCHEDULER_ENABLED');
    expect(process.env['QUANT_PRIORITY_SCHEDULER_ENABLED']).not.toBe('true');
  });

  it('quant-stage watchdog: a hung evaluation is quarantined - slot recovered, dedup kept, no duplicate', async () => {
    // Defect found in review: the quant stage had no liveness watchdog, so a hung
    // evaluateSymbol() would hold its quant slot forever; pool-size hangs would wedge
    // quant throughput permanently. The watchdog quarantines: slot released, dedup kept.
    const h = harness({
      quantWorkerPoolSize: 1,
      dataFetchPoolSize: 4,
      quantEvaluationTimeoutMs: 200,
      quantQuarantineMaxAgeMs: 60_000,
      sweepIntervalMs: 50,
    });
    h.seedBars('HANG', 400, 30 * 60_000);
    h.seedBars('OK2', 400, 30 * 60_000);
    h.setEvaluatorHangs('HANG');
    h.setEvaluatorDelay(50);

    const hangAdmission = h.admit({ symbol: 'HANG', priority: P2, source: 'CYCLE' });
    await sleep(100); // HANG is in flight, holding the only quant slot.
    // While HANG is hung, a re-admission dedups - no duplicate evaluation starts.
    const dupe = h.admit({ symbol: 'HANG', priority: P0, source: 'MOVER' });
    expect(dupe.accepted).toBe(true);
    if (!dupe.accepted) throw new Error('unreachable');
    expect(dupe.deduped).toBe(true);

    // The watchdog fires at 200ms: the slot is quarantined (released to the pool)
    // while the dedup entry is kept. OK2 is evaluated despite HANG never settling.
    const ok2Outcome = await h.admit({ symbol: 'OK2', priority: P2, source: 'CYCLE' }).outcome;
    expect(ok2Outcome.terminalState).toBe('ASSESSED');
    expect(h.scheduler.getMetrics().quantQuarantined).toBe(1);
    expect(h.evaluateCallsBySymbol.get('HANG')).toBe(1); // exactly one evaluation, never duplicated
    expect(h.events.some((e) => e.type === 'QUANT_SCHEDULER_QUANT_QUARANTINED')).toBe(true);
    // HANG's outcome is still pending (orphan unsettled) - the quarantine is honest,
    // and the afterEach stop() will terminally EVICT it. Awaiting it here would hang.
    expect(hangAdmission.accepted).toBe(true);
  });

  it('quant-stage watchdog: a late settle after quarantine is discarded, never presented as current', async () => {
    const h = harness({
      quantWorkerPoolSize: 1,
      dataFetchPoolSize: 4,
      quantEvaluationTimeoutMs: 200,
      quantQuarantineMaxAgeMs: 60_000,
      sweepIntervalMs: 50,
    });
    h.seedBars('LATE', 400, 30 * 60_000);
    h.setEvaluatorDelay(600); // slower than the 200ms watchdog, but settles eventually
    const o = await h.admit({ symbol: 'LATE', priority: P2, source: 'CYCLE' }).outcome;
    expect(o.terminalState).toBe('ASSESSMENT_EXPIRED');
    expect(o.reasonCode).toBe('QUANT_EVALUATION_TIMED_OUT_LATE_SETTLE');
    expect(o.evaluationSettledLate).toBe(true);
    expect(h.evaluateCallsBySymbol.get('LATE')).toBe(1);
    expect(h.events.some((e) => e.type === 'QUANT_SCHEDULER_QUANT_LATE_SETTLE_DISCARDED')).toBe(true);
  });

  it('quant-stage watchdog: a never-settling quarantine is evicted by age and the dedup entry released', async () => {
    const h = harness({
      quantWorkerPoolSize: 1,
      dataFetchPoolSize: 4,
      quantEvaluationTimeoutMs: 150,
      quantQuarantineMaxAgeMs: 400,
      dedupWindowMs: 200,
      sweepIntervalMs: 50,
    });
    h.seedBars('HANG', 400, 30 * 60_000);
    h.seedBars('HANG2', 400, 30 * 60_000);
    h.setEvaluatorHangs('HANG');
    h.setEvaluatorHangs('HANG2');

    // Watchdog fires at 150ms -> quarantined; sweeper evicts at 400ms quarantine age.
    const o = await h.admit({ symbol: 'HANG', priority: P2, source: 'CYCLE' }).outcome;
    expect(o.terminalState).toBe('ASSESSMENT_EXPIRED');
    expect(o.reasonCode).toBe('QUANT_QUARANTINE_AGE_EXCEEDED');
    expect(h.evaluateCallsBySymbol.get('HANG')).toBe(1);
    expect(h.scheduler.getMetrics().quantQuarantined).toBe(0);

    // The dedup entry was released and the dedup window has passed: a fresh admission
    // re-evaluates instead of being pinned forever by hung work.
    await sleep(300); // past the 200ms dedup window
    const readmit = h.admit({ symbol: 'HANG', priority: P2, source: 'CYCLE' });
    expect(readmit.accepted).toBe(true);
    if (!readmit.accepted) throw new Error('unreachable');
    expect(readmit.deduped).toBe(false);
    // HANG2 proves the pool itself recovered: it is evaluated despite HANG's orphan.
    const o2 = await h.admit({ symbol: 'HANG2', priority: P2, source: 'CYCLE' }).outcome;
    expect(h.evaluateCallsBySymbol.get('HANG2')).toBe(1);
    expect(o2.terminalState).toBe('ASSESSMENT_EXPIRED'); // hangs again -> quarantined -> evicted
    expect(o2.reasonCode).toBe('QUANT_QUARANTINE_AGE_EXCEEDED');
  });

  it('pipeline guard: a throwing deps call terminally transitions the candidate to ERROR', async () => {
    // Defect found in review: providerRateLimitedUntilMs() throwing (outside every
    // handled path) left the candidate tracked forever with an unhandled rejection
    // and a never-resolving outcome promise. The pipeline guard converts it to an
    // explicit ERROR terminal.
    const h = harness();
    h.seedBars('BOOM', 400, 30 * 60_000);
    h.setProviderRateLimitedThrows();
    const o = await h.admit({ symbol: 'BOOM', priority: P2, source: 'CYCLE' }).outcome;
    expect(o.terminalState).toBe('ERROR');
    expect(o.reasonCode).toMatch(/^SCHEDULER_PIPELINE_FAILED/);
    expect(h.terminalEvents().filter((e) => e.fields['symbol'] === 'BOOM')).toHaveLength(1);
  });

  it('readiness mirror: below minBars but above the coverage ratio is sufficient (no spurious fetch)', async () => {
    // Defect found in review: the readiness check only applied the minBars count
    // floor, while the gateway (and evaluateSymbol) accept count OR coverage ratio.
    // The scheduler would have marked DATA_UNAVAILABLE for windows the gateway
    // would happily evaluate - a routing/enforcement divergence.
    const h = harness();
    h.setExpectedBarCountOverride(55);
    h.seedBars('COV', 50, 30 * 60_000); // 50 < 60 minBars, but 50/55 = 90.9% >= 85%
    const o = await h.admit({ symbol: 'COV', priority: P2, source: 'CYCLE' }).outcome;
    expect(o.terminalState).toBe('ASSESSED');
    expect(h.ensureCalls.filter((s) => s === 'COV')).toHaveLength(0);
  });

  it('external registration: a stale registration is evicted by the sweeper (no permanent block)', async () => {
    // Defect found in review: externalInflight registrations were only removed by
    // the external system's unregister call. A crashed external system would block
    // the symbol's scheduler evaluation forever.
    const h = harness({ externalRegistrationMaxAgeMs: 200, sweepIntervalMs: 50 });
    h.seedBars('STALE', 400, 30 * 60_000);
    const neverSettles = new Promise<unknown>(() => {});
    const unregister = h.scheduler.registerExternalEvaluation('STALE', 'fp', neverSettles);
    const blocked = h.scheduler.admit({ symbol: 'STALE', priority: P0, source: 'MOVER', evaluationFingerprint: 'fp' });
    expect('externalInFlight' in blocked).toBe(true);

    // The external system never unregisters (simulated crash). After max age + sweep
    // the registration is evicted and the scheduler evaluates normally.
    await sleep(350);
    h.scheduler.sweepForTests();
    const admitted = h.scheduler.admit({ symbol: 'STALE', priority: P0, source: 'MOVER', evaluationFingerprint: 'fp' });
    expect('externalInFlight' in admitted).toBe(false);
    if ('externalInFlight' in admitted) throw new Error('unreachable');
    expect((await admitted.outcome).terminalState).toBe('ASSESSED');
    expect(h.events.some((e) => e.type === 'QUANT_SCHEDULER_EXTERNAL_REGISTRATION_EVICTED')).toBe(true);
    unregister(); // no-op cleanup
  });

  it('runQuantSchedulerBatch honors the scheduler\'s own maxBatchWaitMs', async () => {
    // Defect found in review: the batch helper used the production default
    // maxBatchWaitMs instead of the scheduler instance's resolved config.
    const h = harness({ maxBatchWaitMs: 400 });
    h.seedBars('HANG', 400, 30 * 60_000);
    h.setEvaluatorHangs('HANG');
    const startedAt = Date.now();
    const summary = await runQuantSchedulerBatch(h.scheduler, ['HANG'], {
      cycleId: 'test-batch',
      priorityOf: () => P2,
    });
    const elapsed = Date.now() - startedAt;
    expect(summary.reason).toBe('BATCH_WAIT_EXCEEDED');
    expect(summary.notAttemptedSymbols).toContain('HANG');
    expect(elapsed).toBeLessThan(30_000); // 400ms configured wait, not the 240s default
  });
});
