// LABEL: COMPONENT
/**
 * ==========================================================
 * QuantSignalAgent.schedulerSplitBrain.test.ts — split-brain regression tests
 * for the QUANT_PRIORITY_SCHEDULER_ENABLED feature-flag integration.
 *
 * 2026-10-10 (defect hunt, Lead 5): QuantSignalAgent.runCycle reads the feature
 * flag once per cycle and routes to EITHER the bounded priority scheduler OR
 * the legacy sequential fan-out. Two windows let BOTH paths evaluate the same
 * symbol concurrently:
 *
 *  1. Flag transition on->off between cycles: cycle N admitted symbols to the
 *     scheduler and some are still in-flight (runQuantSchedulerBatch's bounded
 *     wait explicitly leaves them tracked); cycle N+1 with the flag off takes
 *     the legacy fan-out while the scheduler's in-flight evaluateSymbol calls
 *     keep running. The scheduler's singleflight dedup only coordinates within
 *     itself - the legacy path never consults it.
 *  2. Fail-closed fallback within one cycle: the scheduler path throws AFTER
 *     admitting candidates; the catch falls through to the legacy fan-out while
 *     the scheduler's in-flight evaluations keep running.
 *
 * The fix: retirePriorityScheduler() stops the scheduler singleton (in-flights
 * terminally EVICTED/SCHEDULER_STOPPED, late settles discarded) before the
 * legacy fan-out runs in both windows - exactly one path evaluates each symbol.
 *
 * PAPER-only control-plane tests: no orders, no thresholds, no lifecycle.
 * ==========================================================
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { QuantSignalAgent } from './QuantSignalAgent';
import {
  QuantCandidatePriority,
  initQuantPriorityScheduler,
  resetQuantPrioritySchedulerForTests,
  type AdmissionResult,
  type CandidateOutcome,
  type QuantSchedulerDeps,
  type SchedulerBar,
} from '../scheduling/quantPriorityScheduler';
import { marketDataWorker } from './MarketDataWorker';

/** AdmissionResult minus the external-dedup variant (this suite never triggers it). */
type OwnedAdmission = Exclude<AdmissionResult, { externalInFlight: true }>;

const FLAG_ENV = 'QUANT_PRIORITY_SCHEDULER_ENABLED';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(10);
  }
}

/**
 * In-memory scheduler deps: fresh cached bars (data readiness passes without a
 * provider fetch), a controllable hanging evaluator, and an order log that
 * records scheduler-side terminal events alongside legacy-path evaluations.
 */
function makeStubSchedulerDeps(order: string[], hangSymbols: Set<string>): QuantSchedulerDeps {
  const freshBars = (): SchedulerBar[] => {
    const now = Date.now();
    const bars: SchedulerBar[] = [];
    // Oldest first, newest last: checkDataReadiness reads the tail (newest) as
    // bars[bars.length - 1].
    for (let i = 399; i >= 0; i--) bars.push({ timestamp: now - 30 * 60_000 - i * 86_400_000 });
    return bars;
  };
  return {
    evaluateSymbol: async (symbol: string) => {
      order.push(`scheduler-eval-start:${symbol}`);
      if (hangSymbols.has(symbol.toUpperCase())) await new Promise<void>(() => {}); // never settles
      order.push(`scheduler-eval-end:${symbol}`);
      return { stubEvaluation: true };
    },
    getBars: async () => freshBars(),
    ensureBars: async () => {},
    providerRateLimitedUntilMs: () => 0,
    minBars: 60,
    lookbackDays: 400,
    emit: (type, fields) => {
      if (type === 'QUANT_SCHEDULER_CANDIDATE_TERMINAL') {
        order.push(`terminal:${fields.symbol}:${fields.terminalState}`);
      }
    },
  };
}

describe('QuantSignalAgent scheduler/legacy split-brain guard', () => {
  const savedEnv = process.env[FLAG_ENV];

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[FLAG_ENV];
    else process.env[FLAG_ENV] = savedEnv;
    resetQuantPrioritySchedulerForTests();
    vi.restoreAllMocks();
  });

  it('flag off retires a live scheduler before the legacy fan-out (no concurrent dual evaluation)', async () => {
    const order: string[] = [];
    const hang = new Set(['AAA']);
    const scheduler = initQuantPriorityScheduler(makeStubSchedulerDeps(order, hang));
    const admission = scheduler.admit({
      symbol: 'AAA',
      priority: QuantCandidatePriority.P2_NORMAL,
      source: 'TEST',
    }) as OwnedAdmission;
    // The scheduler is now authoritatively evaluating AAA (hung in evaluateSymbol).
    await waitFor(() => order.includes('scheduler-eval-start:AAA'));

    // Flag transition: operator turned the flag off after the scheduler admitted AAA.
    delete process.env[FLAG_ENV];
    vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(['AAA']);
    const agent = new QuantSignalAgent();
    vi.spyOn(agent, 'evaluateSymbol').mockImplementation(async (symbol: string) => {
      order.push(`legacy-eval:${symbol}`);
      return null;
    });

    await (agent as any).runCycle();

    // The scheduler must be retired BEFORE the legacy path evaluates AAA.
    expect(scheduler.isStopped()).toBe(true);
    const outcome: CandidateOutcome = await admission.outcome;
    expect(outcome.terminalState).toBe('EVICTED');
    expect(outcome.reasonCode).toBe('SCHEDULER_STOPPED');
    const terminalIdx = order.findIndex((e) => e === 'terminal:AAA:EVICTED');
    const legacyIdx = order.findIndex((e) => e === 'legacy-eval:AAA');
    expect(terminalIdx).toBeGreaterThanOrEqual(0);
    expect(legacyIdx).toBeGreaterThanOrEqual(0);
    expect(terminalIdx).toBeLessThan(legacyIdx);
    expect(scheduler.getMetrics().tracked).toBe(0);
  });

  it('scheduler-path failure retires the scheduler before the legacy fallback fan-out', async () => {
    const order: string[] = [];
    const hang = new Set(['AAA']);
    process.env[FLAG_ENV] = 'true';
    const scheduler = initQuantPriorityScheduler(makeStubSchedulerDeps(order, hang));
    const admission = scheduler.admit({
      symbol: 'AAA',
      priority: QuantCandidatePriority.P2_NORMAL,
      source: 'TEST',
    }) as OwnedAdmission;
    await waitFor(() => order.includes('scheduler-eval-start:AAA'));

    // Simulate the scheduler path failing AFTER admission: runCycleViaScheduler's
    // batch admission throws, so runCycle's catch falls back to the legacy fan-out.
    vi.spyOn(scheduler, 'admit').mockImplementationOnce(() => {
      throw new Error('simulated scheduler-path failure (test fault injection)');
    });
    vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(['AAA']);
    const agent = new QuantSignalAgent();
    vi.spyOn(agent, 'evaluateSymbol').mockImplementation(async (symbol: string) => {
      order.push(`legacy-eval:${symbol}`);
      return null;
    });

    await (agent as any).runCycle();

    expect(scheduler.isStopped()).toBe(true);
    const outcome: CandidateOutcome = await admission.outcome;
    expect(outcome.terminalState).toBe('EVICTED');
    expect(outcome.reasonCode).toBe('SCHEDULER_STOPPED');
    const terminalIdx = order.findIndex((e) => e === 'terminal:AAA:EVICTED');
    const legacyIdx = order.findIndex((e) => e === 'legacy-eval:AAA');
    expect(terminalIdx).toBeGreaterThanOrEqual(0);
    expect(legacyIdx).toBeGreaterThanOrEqual(0);
    expect(terminalIdx).toBeLessThan(legacyIdx);
  });
});
