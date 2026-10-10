// LABEL: COMPONENT / FAULT_INJECTION
/**
 * ==========================================================
 * quantSchedulerForensicRegressions.test.ts — forensic regression scenarios for
 * the bounded priority quant scheduler (2026-10-09 forensic audit).
 *
 * Each test replays the SHAPE of a real Oct-9 missed-opportunity incident against
 * the new scheduler and asserts the scheduling outcome that the old
 * snapshot+worker-pool model failed to deliver. Per the task's regression rule,
 * these tests NEVER assert BUY (or any trading outcome) - they assert timely
 * assessment or an explicit terminal reason.
 *
 * 1. MRNA-style: busy cycle running, high-priority mover admitted mid-cycle with
 *    usable data -> bounded scheduling resolution well under the SLA, never hours.
 *    (Forensic: MRNA admitted 10:27, promoted 10:29, assessed 17:14 - after close.)
 * 2. CRCL-style: admitted+promoted but required bars absent -> the scheduler
 *    attempts, the gateway identifies missing data, a provider fetch runs per
 *    policy -> ASSESSED / DATA_UNAVAILABLE / PROVIDER_BACKOFF / PROVIDER_TIMEOUT,
 *    never a silent disappearance.
 *    (Forensic: CRCL admitted+promoted but never assessed at all.)
 * 3. COMBINED (highest value): late admission + sufficient-row-count-but-stale-tail
 *    cache + slow provider + busy cycle + Fast Lane active -> stale detected,
 *    refresh attempted, lease held, no duplicate evaluation, scheduler bounded,
 *    explicit final state. Exercises the REAL HistoricalDataGateway.ensureBars
 *    stale-tail gate (Task A, committed as f9277c7) and the scheduler's
 *    fast-lane lease coordination contract (Task B's held-lease guarantee,
 *    committed as 27e17d3; the fast-lane side of the lease is covered by
 *    fastLaneEvaluator.test.ts - here the scheduler honors an active external
 *    lease via registerExternalEvaluation and never duplicates it).
 * ==========================================================
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  QuantPriorityScheduler,
  QuantCandidatePriority,
  type AdmissionResult,
  type QuantSchedulerDeps,
  type QuantSchedulerCandidate,
  type CandidateOutcome,
} from './quantPriorityScheduler';
import { tradingSafety } from '../config/tradingSafety';

/** AdmissionResult minus the external-dedup variant (these tests never trigger it). */
type OwnedAdmission = Exclude<AdmissionResult, { externalInFlight: true }>;

function admitOwned(
  scheduler: QuantPriorityScheduler,
  candidate: QuantSchedulerCandidate,
): OwnedAdmission {
  const a = scheduler.admit(candidate);
  if ('externalInFlight' in a) throw new Error('test admission unexpectedly coalesced onto an external evaluation');
  return a;
}

const P0 = QuantCandidatePriority.P0_URGENT_MOVER;
const P1 = QuantCandidatePriority.P1_PROMOTED;
const P2 = QuantCandidatePriority.P2_NORMAL;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Shared stub harness (in-memory gateway) for the MRNA/CRCL scenarios
// ---------------------------------------------------------------------------
interface StubHarness {
  scheduler: QuantPriorityScheduler;
  seedFresh: (symbol: string) => void;
  setFetchBehavior: (symbol: string, b: 'ok' | 'throw429' | 'hang') => void;
  setFetchDelivers: (symbol: string, delivers: boolean) => void;
  setEvaluatorDelayMs: (ms: number) => void;
  evaluatedSymbols: string[];
}

function makeStubHarness(dataFetchTimeoutMs?: number): StubHarness {
  const bars = new Map<string, Array<{ timestamp: number }>>();
  const fetchBehavior = new Map<string, 'ok' | 'throw429' | 'hang'>();
  const fetchDelivers = new Map<string, boolean>();
  const evaluatedSymbols: string[] = [];
  let evaluatorDelayMs = 0;
  const DAY_MS = 86_400_000;

  const seedFresh = (symbol: string): void => {
    const now = Date.now();
    const arr: Array<{ timestamp: number }> = [];
    for (let i = 399; i >= 0; i--) arr.push({ timestamp: now - 30 * 60_000 - i * DAY_MS });
    bars.set(symbol.toUpperCase(), arr);
  };

  const deps: QuantSchedulerDeps = {
    evaluateSymbol: async (symbol: string) => {
      evaluatedSymbols.push(symbol);
      if (evaluatorDelayMs > 0) await sleep(evaluatorDelayMs);
      return { stub: true };
    },
    getBars: async (symbol: string) => [...(bars.get(symbol.toUpperCase()) ?? [])],
    ensureBars: async (symbol: string) => {
      const key = symbol.toUpperCase();
      const b = fetchBehavior.get(key) ?? 'ok';
      if (b === 'hang') await new Promise<void>(() => {});
      if (b === 'throw429') throw new Error('429 Too Many Requests (test)');
      if (fetchDelivers.get(key) !== false) seedFresh(symbol);
    },
    providerRateLimitedUntilMs: () => 0,
    minBars: 60,
    expectedBarCount: () => 400,
    lookbackDays: 400,
    config: dataFetchTimeoutMs !== undefined ? { dataFetchTimeoutMs } : undefined,
    emit: () => {},
  };
  const scheduler = new QuantPriorityScheduler(deps);
  scheduler.start();
  return {
    scheduler,
    seedFresh,
    setFetchBehavior: (s, b) => fetchBehavior.set(s.toUpperCase(), b),
    setFetchDelivers: (s, d) => fetchDelivers.set(s.toUpperCase(), d),
    setEvaluatorDelayMs: (ms) => {
      evaluatorDelayMs = ms;
    },
    evaluatedSymbols,
  };
}

describe('quant scheduler forensic regressions (2026-10-09 incidents)', () => {
  it('MRNA-style: high-priority mover admitted mid-cycle resolves in seconds, never hours', async () => {
    const evaluatedSymbols: string[] = [];
    const DAY = 86_400_000;
    const deps: QuantSchedulerDeps = {
      evaluateSymbol: async (symbol: string) => {
        evaluatedSymbols.push(symbol);
        await sleep(symbol === 'MRNAX' ? 50 : 400);
        return { stub: true };
      },
      getBars: async () => {
        // Usable data for every symbol in this scenario (fresh 400-bar caches).
        const now = Date.now();
        const arr: Array<{ timestamp: number }> = [];
        for (let i = 399; i >= 0; i--) arr.push({ timestamp: now - 30 * 60_000 - i * DAY });
        return arr;
      },
      ensureBars: async () => {},
      providerRateLimitedUntilMs: () => 0,
      minBars: 60,
      lookbackDays: 400,
      config: { quantWorkerPoolSize: 2, dataFetchPoolSize: 4 },
      emit: () => {},
    };
    const scheduler = new QuantPriorityScheduler(deps);
    scheduler.start();
    try {
      // Busy cycle: six normal symbols admitted at once (the "cycle already running").
      const busyOutcomes = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'].map(
        (s) => admitOwned(scheduler, { symbol: s, priority: P2, source: 'CYCLE' }).outcome,
      );
      // 10:29-style: the mover is promoted and admitted mid-cycle with usable data.
      await sleep(150);
      const admittedAt = Date.now();
      const mrna = admitOwned(scheduler, { symbol: 'MRNAX', priority: P0, source: 'MOVER' });
      expect(mrna.accepted).toBe(true);

      const mrnaOutcome = await mrna.outcome;
      const wallMs = Date.now() - admittedAt;
      // The forensic failure was admission->assessment measured in HOURS (10:27 -> 17:14).
      // The scheduler must resolve it in seconds - far below the 60s HIGH complete SLA.
      expect(mrnaOutcome.terminalState).toBe('ASSESSED');
      expect(mrnaOutcome.admissionToTerminalMs).toBeLessThan(10_000);
      expect(mrnaOutcome.admissionToTerminalMs).toBeLessThanOrEqual(
        tradingSafety.quantSchedulerHighPriorityAdmissionToCompleteSlaMs,
      );
      expect(wallMs).toBeLessThan(10_000);
      // It did not wait for the whole busy cycle to drain first.
      const busyDone = await Promise.all(busyOutcomes);
      const lastBusyStart = Math.max(...busyDone.map((o) => o.stages.quantStartedAtMs ?? 0));
      expect(mrnaOutcome.stages.quantStartedAtMs).toBeLessThan(lastBusyStart);
    } finally {
      scheduler.stop();
    }
  });

  it('CRCL-style: admitted+promoted but required bars absent -> explicit terminal, never silent', async () => {
    // Case 1: provider rate-limits the fetch -> PROVIDER_BACKOFF.
    {
      const h = makeStubHarness();
      try {
        h.setFetchBehavior('CRCL', 'throw429'); // no bars seeded: required bars absent
        const o = await admitOwned(h.scheduler, { symbol: 'CRCL', priority: P1, source: 'MOVER' }).outcome;
        expect(o.terminalState).toBe('PROVIDER_BACKOFF');
        expect(o.reasonCode).toBe('DATA_FETCH_RATE_LIMITED');
        expect(o.stages.dataFetchStartedAtMs).not.toBeNull(); // the scheduler attempted
        expect(h.evaluatedSymbols).not.toContain('CRCL'); // never evaluated without data
      } finally {
        h.scheduler.stop();
      }
    }
    // Case 2: fetch runs per policy but the provider has no bars -> DATA_UNAVAILABLE.
    {
      const h = makeStubHarness();
      try {
        h.setFetchDelivers('CRCL', false); // fetch succeeds, still no bars
        const o = await admitOwned(h.scheduler, { symbol: 'CRCL', priority: P1, source: 'MOVER' }).outcome;
        expect(o.terminalState).toBe('DATA_UNAVAILABLE');
        expect(o.reasonCode).toBe('DATA_STILL_INSUFFICIENT_AFTER_FETCH');
      } finally {
        h.scheduler.stop();
      }
    }
    // Case 3: provider hangs -> PROVIDER_TIMEOUT (bounded, never wedged).
    {
      const h = makeStubHarness(300);
      try {
        h.setFetchBehavior('CRCL', 'hang');
        const o = await admitOwned(h.scheduler, { symbol: 'CRCL', priority: P1, source: 'MOVER' }).outcome;
        expect(o.terminalState).toBe('PROVIDER_TIMEOUT');
      } finally {
        h.scheduler.stop();
      }
    }
  });

  describe('COMBINED: stale-tail + slow provider + busy cycle + fast lane active (real gateway)', () => {
    let tmpDbPath: string;
    let db: any;
    let sqliteDb: any;
    let schema: any;
    let historicalDataGateway: any;
    const originalAlpacaKey = process.env.ALPACA_API_KEY;
    const originalAlpacaSecret = process.env.ALPACA_SECRET_KEY;

    beforeAll(async () => {
      tmpDbPath = path.join(os.tmpdir(), `argus_sched_combined_${Date.now()}_${process.pid}.db`);
      process.env.ARGUS_DB_PATH = tmpDbPath;
      // Test-only placeholder credentials (the provider HTTP call itself is stubbed via
      // vi.stubGlobal('fetch'); the gateway only checks these are non-empty).
      process.env.ALPACA_API_KEY = ['test', 'key'].join('-');
      process.env.ALPACA_SECRET_KEY = ['test', 'secret'].join('-');
      ({ db, sqliteDb } = await import('../db'));
      schema = await import('../db/schema');
      ({ historicalDataGateway } = await import('../engines/backtest/HistoricalDataGateway'));
      // tradingSafety is imported at module top (config-only, no DB) - no re-import needed.
    }, 120_000);

    afterAll(() => {
      try {
        sqliteDb.close();
      } catch {
        /* already closed */
      }
      for (const suffix of ['', '-shm', '-wal']) {
        try {
          fs.unlinkSync(tmpDbPath + suffix);
        } catch {
          /* best-effort */
        }
      }
      delete process.env.ARGUS_DB_PATH;
      if (originalAlpacaKey === undefined) delete process.env.ALPACA_API_KEY;
      else process.env.ALPACA_API_KEY = originalAlpacaKey;
      if (originalAlpacaSecret === undefined) delete process.env.ALPACA_SECRET_KEY;
      else process.env.ALPACA_SECRET_KEY = originalAlpacaSecret;
      vi.unstubAllGlobals();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      historicalDataGateway.clearBarsRateLimitBackoff();
    });

    it('stale detected, refresh attempted, lease held, no duplicate evaluation, bounded, explicit', async () => {
      const now = Date.now();
      const DAY = 86_400_000;
      // Sufficient row count (400 >= 60) but a 10-day-old tail: Task A's gate must fire.
      const newestTs = now - 10 * DAY;
      const start = newestTs - 399 * DAY;
      for (let i = 0; i < 400; i++) {
        const ts = start + i * DAY;
        await db.insert(schema.ohlcvBars).values({
          id: `STALEX:1Day:${ts}`, symbol: 'STALEX', timeframe: '1Day', timestamp: ts,
          open: 10, high: 11, low: 9, close: 10.5, volume: 1000, source: 'alpaca',
        }).onConflictDoNothing();
      }

      // Slow provider: 400ms per fetch, then fresh bars (tail moves to 30min ago).
      const freshTs = now - 30 * 60_000;
      const fetchMock = vi.fn(async (..._args: unknown[]) => {
        await sleep(400);
        return {
          ok: true,
          json: async () => ({
            bars: [
              { t: new Date(now - DAY).toISOString(), o: 10, h: 11, l: 9, c: 10.5, v: 1000 },
              { t: new Date(freshTs).toISOString(), o: 10, h: 11, l: 9, c: 10.6, v: 1200 },
            ],
          }),
        };
      });
      vi.stubGlobal('fetch', fetchMock);

      const evaluatedSymbols: string[] = [];
      const events: Array<{ type: string; fields: Record<string, unknown> }> = [];
      const deps: QuantSchedulerDeps = {
        evaluateSymbol: async (symbol: string) => {
          evaluatedSymbols.push(symbol);
          // Busy cycle: normal symbols take 600ms; the stale symbol is fast once data is ready.
          await sleep(symbol.startsWith('BUSY') ? 600 : 50);
          return { stub: true };
        },
        getBars: (s: string, tf: string, sMs: number, eMs: number) => historicalDataGateway.getBars(s, tf, sMs, eMs),
        ensureBars: (s: string, tf: string, sMs: number, eMs: number) => historicalDataGateway.ensureBars(s, tf, sMs, eMs),
        providerRateLimitedUntilMs: () => historicalDataGateway.getBarsRateLimitedUntilMs(),
        minBars: tradingSafety.regimeMinBars,
        lookbackDays: 400,
        config: { quantWorkerPoolSize: 2, dataFetchPoolSize: 2 },
        emit: (type, fields) => events.push({ type, fields }),
      };
      const scheduler = new QuantPriorityScheduler(deps);
      scheduler.start();
      try {
        // Fresh 400-bar caches for the BUSY symbols (seeded BEFORE admission so the
        // readiness check deterministically sees warm data).
        for (const s of ['BUSY1', 'BUSY2', 'BUSY3', 'BUSY4']) {
          const bStart = now - 399 * DAY;
          for (let i = 0; i < 400; i++) {
            const ts = bStart + i * DAY;
            await db.insert(schema.ohlcvBars).values({
              id: `${s}:1Day:${ts}`, symbol: s, timeframe: '1Day', timestamp: ts,
              open: 10, high: 11, low: 9, close: 10.5, volume: 1000, source: 'alpaca',
            }).onConflictDoNothing();
          }
        }
        // Busy cycle: saturate both quant workers.
        const busyOutcomes = ['BUSY1', 'BUSY2', 'BUSY3', 'BUSY4'].map(
          (s) => admitOwned(scheduler, { symbol: s, priority: P2, source: 'CYCLE' }).outcome,
        );

        // Fast Lane active with its lease held (Task B): the scheduler must not duplicate it.
        let resolveExternal!: (v: unknown) => void;
        const externalDone = new Promise<unknown>((resolve) => {
          resolveExternal = resolve;
        });
        const unregisterExternal = scheduler.registerExternalEvaluation('FASTX', 'fastlane-combined', externalDone);

        // Late admission, mid-cycle: the stale-tail P0 and the fast-lane P0.
        await sleep(150);
        const staleAdmission = admitOwned(scheduler, { symbol: 'STALEX', priority: P0, source: 'MOVER' });
        const fastAdmission = scheduler.admit({
          symbol: 'FASTX', priority: P0, source: 'MOVER', evaluationFingerprint: 'fastlane-combined',
        });
        expect('externalInFlight' in fastAdmission).toBe(true);
        if (!('externalInFlight' in fastAdmission)) throw new Error('expected external dedup');
        expect(fastAdmission.accepted).toBe(false);
        expect(fastAdmission.deduped).toBe(true); // lease held: coalesced, not duplicated

        const staleOutcome: CandidateOutcome = await staleAdmission.outcome;
        // Stale tail was detected (not waved through on row count)...
        expect(staleOutcome.stages.dataFetchStartedAtMs).not.toBeNull();
        // ...a real provider refresh was attempted (Task A's gate fired)...
        expect(fetchMock).toHaveBeenCalled();
        // ...and the candidate resolved explicitly and quickly.
        expect(staleOutcome.terminalState).toBe('ASSESSED');
        expect(staleOutcome.admissionToTerminalMs).toBeLessThan(20_000);

        // No duplicate evaluation while the fast-lane lease was held.
        expect(evaluatedSymbols.filter((s) => s === 'FASTX')).toHaveLength(0);
        resolveExternal({ status: 'VALID_STRATEGY_EVIDENCE' });
        unregisterExternal();

        const busyDone = await Promise.all(busyOutcomes);
        for (const o of busyDone) expect(o.terminalState).toBe('ASSESSED');

        // Every candidate reached exactly one terminal state; every terminal was observed.
        const terminals = events.filter((e) => e.type === 'QUANT_SCHEDULER_CANDIDATE_TERMINAL');
        const terminalSymbols = terminals.map((e) => e.fields['symbol']);
        for (const s of ['STALEX', 'BUSY1', 'BUSY2', 'BUSY3', 'BUSY4']) {
          expect(terminalSymbols.filter((x) => x === s)).toHaveLength(1);
        }
        // FASTX never got a scheduler terminal - its evaluation stayed externally owned.
        expect(terminalSymbols).not.toContain('FASTX');
      } finally {
        scheduler.stop();
      }
    }, 60_000);
  });
});
