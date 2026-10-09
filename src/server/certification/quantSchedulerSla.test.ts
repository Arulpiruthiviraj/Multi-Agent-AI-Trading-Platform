/**
 * ==========================================================
 * Phase 3 certification — Quant scheduler SLA / completeness / late-admission tests
 *
 * What this certifies: the QuantSignalAgent scheduling layer (runCycle) keeps its promises
 * under the CURRENT production design — every symbol in a cycle's universe snapshot reaches a
 * terminal, forensically visible outcome; a full cycle always emits a bounded STARTED →
 * COMPLETED event pair; a symbol admitted mid-cycle is picked up by the very next cycle with a
 * bounded admission→outcome latency.
 *
 * What this does NOT certify: alpha, edge, or any trading outcome. The seeded bars below are
 * deliberately pattern-free (tiny deterministic wiggle, no trend/breakout) so the tests assert
 * on SCHEDULING (did every symbol resolve? how long did the cycle take?) rather than on
 * strategy decisions. Per the standing testing principle, these tests control the ENVIRONMENT
 * (bars in an isolated temp DB), never the DECISION — no strategy is promoted, no lifecycle row
 * is seeded, no threshold is lowered, no idea is forced.
 *
 * Labels: COMPONENT (real runCycle, real evaluateSymbol, real SQLite, stubbed universe +
 * fault-injected provider errors); FAULT_INJECTION (the 429/backoff test).
 *
 * ----------------------------------------------------------------------------
 * SLA DEFINITIONS (chosen here, justified below)
 * ----------------------------------------------------------------------------
 * All values derive from production config — tests must never hardcode a config number
 * (repo AGENTS.md). `tradingSafety.quantCycleIntervalMs` = 300_000 (5 min, verified in
 * config/tradingSafety.json); `tradingSafety.quantMaxConcurrentSymbols` = 1 (verified).
 *
 * - CYCLE_COMPLETION: a QUANT_CYCLE_COMPLETED event (with matching cycleId) is emitted for
 *   every started cycle, and a cycle's own duration (STARTED → COMPLETED) never exceeds
 *   cycleBudget, where
 *       cycleBudget = min(3 × quantCycleIntervalMs, universeSize × 30s + 60s).
 *   Justification: 30s/symbol is a generous upper bound for one evaluateSymbol pass — the
 *   evaluation is pure CPU over daily bars (no per-symbol AI call in the no-idea path; the
 *   AI contradiction review only runs when a real idea exists and is itself bounded by
 *   tradingSafety.quantContradictionMaxWaitMs, a latency bound, not a trading threshold).
 *   The +60s covers cycle setup, DB persistence, and fire-and-forget shadow telemetry
 *   settlement. The 3×interval cap keeps the budget from growing unboundedly with universe
 *   size: beyond it the cycle is structurally unable to keep cadence (see
 *   QUANT_RESEARCH_REQUIRED #1) and that is a capacity finding, not a bigger budget.
 * - HIGH_PRIORITY admission → first terminal outcome within ONE FULL CYCLE DURATION
 *   (quantCycleIntervalMs + cycleBudget). This is the honest floor of the CURRENT design:
 *   the quant lane has no mover fast-path (the hard-coded priority list in runCycle only
 *   REORDERS the existing universe snapshot; it cannot admit or expedite a symbol), so a
 *   freshly admitted symbol can at best be evaluated in the cycle that is already running
 *   or the next one. The 180s admission target from the mission brief is DOCUMENTED as
 *   requiring the fast-lane extension (src/server/fastlane/ — currently NEWS_CATALYST-only
 *   and off by default) and is explicitly NOT implemented here.
 * - LATE-ADMISSION: a symbol subscribed mid-cycle MUST appear in the NEXT cycle's attempted
 *   set, and subscribedAtMs → first terminal outcome ≤ one full cycle duration. It must
 *   never wait an unpredictable time.
 *
 * Terminal outcome (per symbol, per cycle) = exactly one of:
 *   (a) a quant_assessments row (ASSESSED — includes the no-idea assessments),
 *   (b) a DESK_NO_TRADE code (e.g. INSUFFICIENT_BARS via the new H3 hook),
 *   (c) a QUANT_SYMBOL_EVAL_FINISHED event with a non-ASSESSED outcome (RATE_LIMITED/ERROR),
 *   (d) membership in notAttemptedSymbols of a QUANT_CYCLE_COMPLETED with reason
 *       PROVIDER_BACKOFF (the 429-abort resume path).
 * The completeness test FAILS if any symbol in the universe snapshot has none of these —
 * the pre-H2/H3 silent skip (console.log only) is precisely what made such a disappearance
 * possible, and these hooks are what make it visible.
 *
 * ----------------------------------------------------------------------------
 * QUANT_RESEARCH_REQUIRED (structural findings — recorded, NOT retuned)
 * ----------------------------------------------------------------------------
 * 1. Single-flight tick coalescing vs CYCLE_COMPLETION cadence. runCycle is guarded by
 *    createSingleFlightGuard (src/server/core/singleFlightInterval.ts): a timer tick that
 *    fires while a cycle is in-flight is SKIPPED (counted in guard metrics, never queued) —
 *    a deliberate P1-A remediation against overlapping-cycle memory growth. Consequence: the
 *    5-minute interval is a MINIMUM spacing that holds only while cycles finish faster than
 *    the interval. With quantMaxConcurrentSymbols=1, cycle duration grows linearly with
 *    universe size; once a cycle overruns the interval, completion cadence degrades to one
 *    completion per cycle-duration with no catch-up, and ticks during the overrun vanish
 *    from the schedule (visible only via the guard's totalSkippedInFlight metric). No SLA
 *    can promise interval cadence under overrun without changing the guard — an operator /
 *    research decision, not a test constant to inflate.
 * 2. 180s high-priority admission target. Requires a real mover fast-path in the quant lane
 *    (today: none — priority list is reorder-only; universe snapshot is fixed at cycle top,
 *    L320). The fast-lane subsystem (src/server/fastlane/) has full lifecycle timestamps
 *    but only subscribes to NEWS_CATALYST events and is off by default. Extending it to
 *    market-mover admission is a design decision for research, not this mission.
 * 3. Mid-cycle snapshot fixation. A symbol admitted mid-cycle is NEVER picked up by the
 *    in-flight cycle, even if its position hasn't been evaluated yet (universe is read ONCE
 *    at cycle top). Test 3 certifies the bounded next-cycle pickup; changing the snapshot
 *    behavior itself would be a scheduling-semantics change for research.
 * ==========================================================
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';

// ---- lazily imported after ARGUS_DB_PATH is set (same pattern as
// AiOfflineQuantCertification.test.ts) so the suite never touches data/argus.db ----
let db: any;
let schema: any;
let eventBus: any;
let EVENTS: any;
let marketDataWorker: any;
let quantSignalAgent: any;
let historicalDataGateway: any;
let barProviderModule: any;
let structuredLogger: any;
let flushObservabilityStore: () => Promise<void>;
let tradingSafety: any;

let tmpDbPath: string;

// ---------------------------------------------------------------------------
// SLA constants (justified in the header; interval/concurrency from config)
// ---------------------------------------------------------------------------
const PER_SYMBOL_BUDGET_MS = 30_000; // generous upper bound per evaluateSymbol pass — see header
const FIXED_CYCLE_OVERHEAD_MS = 60_000; // setup + persistence + shadow telemetry settlement
const cycleBudgetMs = (universeSize: number): number =>
  Math.min(3 * tradingSafety.quantCycleIntervalMs, universeSize * PER_SYMBOL_BUDGET_MS + FIXED_CYCLE_OVERHEAD_MS);
const fullCycleSlaMs = (universeSize: number): number =>
  tradingSafety.quantCycleIntervalMs + cycleBudgetMs(universeSize);

const DAY_MS = 86_400_000;
const BENCHMARK_SYMBOLS = ['SPY', 'QQQ', 'IWM']; // getMarketContext always fetches these via the gateway

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic, pattern-free daily bars: tiny sinusoidal wiggle (±0.12%), no trend, no
 *  breakout, constant volume. Seeded with source=CERTIFICATION_FIXTURE so the rows are never
 *  mistaken for organic provider data. `count` must be >= 60 (regimeMinBars) for the seeded
 *  symbol to take the real evaluation path instead of the INSUFFICIENT_BARS path. */
async function seedDailyBars(symbol: string, count: number, basePrice: number): Promise<void> {
  const dayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS; // start of today UTC — every bar final
  const rows: any[] = [];
  let prevClose = basePrice;
  for (let i = count - 1; i >= 0; i--) {
    const ts = dayStart - i * DAY_MS;
    const wiggle = 0.0008 * Math.sin(i / 9) + 0.0004 * Math.sin(i / 3.7);
    const close = basePrice * (1 + wiggle);
    const open = prevClose;
    rows.push({
      id: `${symbol}:1Day:${ts}`,
      symbol,
      timeframe: '1Day',
      timestamp: ts,
      open,
      high: Math.max(open, close) * 1.0015,
      low: Math.min(open, close) * 0.9985,
      close,
      volume: 2_000_000,
      source: 'CERTIFICATION_FIXTURE',
      provisional: 0,
    });
    prevClose = close;
  }
  for (const row of rows) await db.insert(schema.ohlcvBars).values(row);
}

function parsePayload(row: any): any {
  try {
    return JSON.parse(row.payload ?? '{}');
  } catch {
    return {};
  }
}

/** All observability_events rows for one event type, newest last. Flushes first. */
async function readEvents(eventType: string): Promise<any[]> {
  await flushObservabilityStore();
  return db
    .select()
    .from(schema.observabilityEvents)
    .all()
    .filter((r: any) => r.eventType === eventType);
}

function payloadOf(row: any): any {
  return { ...parsePayload(row), _ts: row.ts, _traceId: row.traceId, _symbol: row.symbol };
}

async function assessmentRowsSince(symbol: string, sinceIso: string): Promise<any[]> {
  return db
    .select()
    .from(schema.quantAssessments)
    .all()
    .filter((r: any) => r.symbol === symbol && r.createdAt >= sinceIso);
}

// DESK_NO_TRADE capture (synchronous in-process subscription, like production's EventStore)
let noTradeEvents: Array<{ traceId: string; symbol: string; code: string }> = [];
function onDeskNoTrade(payload: any): void {
  noTradeEvents.push({ traceId: payload?.traceId, symbol: payload?.symbol, code: payload?.code });
}

beforeAll(async () => {
  tmpDbPath = path.join(os.tmpdir(), `argus_quant_sched_sla_${Date.now()}_${process.pid}.db`);
  process.env.ARGUS_DB_PATH = tmpDbPath;
  process.env.PAPER_TRADING_ONLY = 'true';
  process.env.QUANT_ENGINE_ENABLED = 'true';
  // Keep the suite on the deterministic quant path: no independent-qualification override,
  // no confluence-guard suppression — both are separate, already-tested features.
  process.env.ARGUS_QUANT_INDEPENDENT_QUALIFICATION_ENABLED = 'false';
  process.env.ARGUS_STRATEGY_SELECTION_CONFLUENCE_GUARD_ENABLED = 'false';

  ({ db } = await import('../db'));
  schema = await import('../db/schema');
  ({ eventBus } = await import('../core/EventBus'));
  EVENTS = (await import('../core/eventNames')).EVENTS;
  ({ marketDataWorker } = await import('../services/MarketDataWorker'));
  ({ quantSignalAgent } = await import('../services/QuantSignalAgent'));
  ({ historicalDataGateway } = await import('../engines/backtest/HistoricalDataGateway'));
  barProviderModule = await import('../engines/backtest/historicalBarProvider');
  ({ structuredLogger } = await import('../observability/StructuredLogger'));
  ({ flushObservabilityStore } = await import('../observability/ObservabilityStore'));
  ({ tradingSafety } = await import('../config/tradingSafety'));

  // Benchmark bars every getMarketContext call needs (DB-only; never a network fetch).
  for (const sym of BENCHMARK_SYMBOLS) await seedDailyBars(sym, 400, 100);

  eventBus.subscribe(EVENTS.DESK_NO_TRADE, onDeskNoTrade);
}, 120_000);

afterEach(() => {
  vi.restoreAllMocks();
  noTradeEvents = [];
  // The singleton carries resume state across cycles; each test starts from a clean slate.
  if (quantSignalAgent) (quantSignalAgent as any).nextCycleSymbol = null;
});
describe('quant scheduler SLA / completeness / late-admission (Phase 3 certification)', () => {
  it(
    'COMPONENT: a full cycle emits a bounded STARTED → per-symbol STARTED/FINISHED → COMPLETED chain with one cycleId',
    { timeout: 180_000 },
    async () => {
      const universe = ['TST1', 'TST2', 'TST3', 'TST4', 'TST5'];
      for (const sym of universe) await seedDailyBars(sym, 400, 100);
      vi.spyOn(marketDataWorker, 'getActiveSymbols').mockImplementation(() => [...universe]);

      // Fresh high-priority admission just before the cycle; the production accessor
      // getSubscribedAtMs() is the source of truth for the latency assertion below.
      const admissionMs = Date.now();
      (marketDataWorker as any).subscribedAtMs.set('TST1', admissionMs);
      expect(marketDataWorker.getSubscribedAtMs('TST1')).toBe(admissionMs);

      const startedBefore = (await readEvents('QUANT_CYCLE_STARTED')).length;
      const sinceIso = new Date().toISOString();
      await quantSignalAgent.triggerNow();

      // --- H1: exactly one STARTED and one COMPLETED, joined by cycleId ---
      const startedMine = (await readEvents('QUANT_CYCLE_STARTED')).slice(startedBefore);
      expect(startedMine).toHaveLength(1);
      const completedMine = (await readEvents('QUANT_CYCLE_COMPLETED')).filter(
        (r) => r.ts >= startedMine[0].ts,
      );
      expect(completedMine).toHaveLength(1);
      const s = payloadOf(startedMine[0]);
      const c = payloadOf(completedMine[0]);
      expect(s.cycleId).toBeTruthy();
      expect(c.cycleId).toBe(s.cycleId); // H1: cycleId carried into the completed event
      expect(s.universeSize).toBe(5);
      expect(s.concurrency).toBe(tradingSafety.quantMaxConcurrentSymbols); // 1, from config
      expect(s.scheduledAtMs).toBeLessThanOrEqual(s._ts);
      expect(s.scheduledAtMs).toBeGreaterThanOrEqual(admissionMs - 1000);

      // --- CYCLE_COMPLETION SLA: every symbol attempted, duration within budget ---
      expect(c.reason).toBe('COMPLETED');
      expect([...c.attemptedSymbols].sort()).toEqual([...universe].sort());
      expect([...c.completedSymbols].sort()).toEqual([...universe].sort());
      expect(c.notAttemptedSymbols).toEqual([]);
      expect(c.durationMs).toBeGreaterThanOrEqual(0);
      expect(c.durationMs).toBeLessThanOrEqual(cycleBudgetMs(5));

      // --- H2: per-symbol STARTED → FINISHED for every symbol, same cycleId + traceId ---
      const symStarted = (await readEvents('QUANT_SYMBOL_EVAL_STARTED')).filter(
        (r) => payloadOf(r).cycleId === s.cycleId,
      );
      const symFinished = (await readEvents('QUANT_SYMBOL_EVAL_FINISHED')).filter(
        (r) => payloadOf(r).cycleId === s.cycleId,
      );
      expect(symStarted).toHaveLength(5);
      expect(symFinished).toHaveLength(5);
      const startedIdx = symStarted.map((r) => payloadOf(r).scheduledIndex).sort((a: number, b: number) => a - b);
      expect(startedIdx).toEqual([0, 1, 2, 3, 4]); // position in the universe snapshot
      const traceBySymbol = new Map(symStarted.map((r) => [payloadOf(r)._symbol, payloadOf(r)._traceId]));
      for (const r of symFinished) {
        const p = payloadOf(r);
        expect(p._traceId).toBe(traceBySymbol.get(p._symbol)); // STARTED/FINISHED share the trace
        expect(p.outcome).toBe('ASSESSED');
      }

      // --- every symbol persisted exactly one assessment this cycle ---
      for (const sym of universe) {
        expect((await assessmentRowsSince(sym, sinceIso)).length).toBe(1);
      }

      // --- HIGH_PRIORITY SLA: fresh admission → first terminal outcome ≤ one full cycle ---
      const t1Finish = symFinished.map(payloadOf).find((p) => p._symbol === 'TST1');
      const latencyMs = t1Finish._ts - marketDataWorker.getSubscribedAtMs('TST1');
      expect(latencyMs).toBeGreaterThanOrEqual(0);
      expect(latencyMs).toBeLessThanOrEqual(fullCycleSlaMs(5));
    },
  );

  it(
    'COMPONENT + FAULT_INJECTION: every symbol in the universe snapshot reaches a terminal, visible outcome — 429 backoff and insufficient bars included',
    { timeout: 180_000 },
    async () => {
      const universe = ['TSA1', 'TSA2', 'TSNODATA', 'TSR429', 'TSA3', 'TSA4'];
      for (const sym of ['TSA1', 'TSA2', 'TSA3', 'TSA4']) await seedDailyBars(sym, 400, 100);
      await seedDailyBars('TSNODATA', 30, 100); // < MIN_BARS (60): the real insufficient-bars path
      await seedDailyBars('TSR429', 400, 100);
      vi.spyOn(marketDataWorker, 'getActiveSymbols').mockImplementation(() => [...universe]);
      vi.spyOn(barProviderModule, 'getRegisteredHistoricalBarProvider').mockReturnValue(null);

      // Fault injection 1: provider 429 with a PARTIAL cache (< 60 bars). evaluateSymbol takes
      // its existing cache-only path, getBars returns 30 bars → INSUFFICIENT_BARS + the H3
      // DESK_NO_TRADE. No throw escapes, so the cycle does NOT abort on this symbol.
      const realEnsure = historicalDataGateway.ensureBars.bind(historicalDataGateway);
      vi.spyOn(historicalDataGateway, 'ensureBars').mockImplementation(
        async (sym: string, tf: string, sMs: number, eMs: number) => {
          if (sym === 'TSNODATA') throw new Error('429 Too Many Requests (test fault injection: partial cache)');
          return realEnsure(sym, tf, sMs, eMs);
        },
      );
      // Fault injection 2: a 429 that escapes evaluateSymbol → runCycle arms PROVIDER_BACKOFF,
      // aborts the fan-out, and records the resume pointer for the next cycle.
      const realGetBars = historicalDataGateway.getBars.bind(historicalDataGateway);
      vi.spyOn(historicalDataGateway, 'getBars').mockImplementation(
        async (sym: string, tf: string, sMs: number, eMs: number) => {
          if (sym === 'TSR429') throw new Error('429 Too Many Requests (test fault injection: abort)');
          return realGetBars(sym, tf, sMs, eMs);
        },
      );

      const sinceIso = new Date().toISOString();
      await quantSignalAgent.triggerNow();

      const completedRows = await readEvents('QUANT_CYCLE_COMPLETED');
      const c = payloadOf(completedRows[completedRows.length - 1]);
      expect(c.reason).toBe('PROVIDER_BACKOFF');
      expect(c.attemptedSymbols).toEqual(['TSA1', 'TSA2', 'TSNODATA', 'TSR429']);
      expect(c.notAttemptedSymbols).toEqual(['TSA3', 'TSA4']);
      expect(c.completedSymbols).toEqual(['TSA1', 'TSA2']);

      // Terminal coverage — the completeness invariant: NO symbol silently disappears.
      // (a) ASSESSED → quant_assessments row.
      for (const sym of ['TSA1', 'TSA2']) {
        expect((await assessmentRowsSince(sym, sinceIso)).length).toBe(1);
      }
      // (b) INSUFFICIENT_BARS → no row BY DESIGN, but the H3 DESK_NO_TRADE code (previously
      //     console.log only — invisible to forensics).
      expect((await assessmentRowsSince('TSNODATA', sinceIso)).length).toBe(0);
      expect(noTradeEvents.filter((e) => e.symbol === 'TSNODATA').map((e) => e.code)).toEqual([
        'INSUFFICIENT_BARS',
      ]);
      // (c) per-symbol FINISHED outcomes pin each symbol's terminal state.
      const finished = (await readEvents('QUANT_SYMBOL_EVAL_FINISHED')).filter(
        (r) => payloadOf(r).cycleId === c.cycleId,
      );
      const outcomeBySymbol = new Map(finished.map((r) => [payloadOf(r)._symbol, payloadOf(r).outcome]));
      expect(outcomeBySymbol.get('TSA1')).toBe('ASSESSED');
      expect(outcomeBySymbol.get('TSA2')).toBe('ASSESSED');
      expect(outcomeBySymbol.get('TSNODATA')).toBe('INSUFFICIENT_BARS');
      expect(outcomeBySymbol.get('TSR429')).toBe('RATE_LIMITED');
      // (d) the not-attempted tail is honestly recorded with the PROVIDER_BACKOFF reason —
      //     no row, no FINISHED event, no silent drop.
      for (const sym of ['TSA3', 'TSA4']) {
        expect((await assessmentRowsSince(sym, sinceIso)).length).toBe(0);
        expect(noTradeEvents.filter((e) => e.symbol === sym)).toEqual([]);
        expect(outcomeBySymbol.has(sym)).toBe(false);
      }
      // Snapshot integrity: attempted ∪ notAttempted === the universe snapshot.
      expect([...c.attemptedSymbols, ...c.notAttemptedSymbols].sort()).toEqual([...universe].sort());
      // The resume pointer is set so the NEXT cycle starts at the tail (fairness, not starvation).
      expect((quantSignalAgent as any).nextCycleSymbol).toBe('TSA3');
    },
  );

  it(
    'COMPONENT: a symbol admitted mid-cycle appears in the NEXT cycle attempted set with bounded admission→outcome latency',
    { timeout: 180_000 },
    async () => {
      const universe = ['TSB1', 'TSB2', 'TSB3', 'TSB4', 'TSB5'];
      for (const sym of [...universe, 'HOTMOVERX']) await seedDailyBars(sym, 400, 100);
      const liveUniverse = [...universe];
      vi.spyOn(marketDataWorker, 'getActiveSymbols').mockImplementation(() => [...liveUniverse]);

      // Admit HOTMOVERX synchronously inside the FIRST per-symbol STARTED event — i.e. strictly
      // AFTER runCycle's once-per-cycle universe snapshot (read at cycle top), strictly BEFORE
      // the cycle completes. Zero timing flakiness: no sleeps, no delays.
      let admitted = false;
      let admissionMs = 0;
      const realInfo = structuredLogger.info.bind(structuredLogger);
      vi.spyOn(structuredLogger, 'info').mockImplementation(((msg: string, fields?: any) => {
        const ret = realInfo(msg, fields);
        if (msg === 'quant_symbol_eval_started' && !admitted) {
          admitted = true;
          admissionMs = Date.now();
          liveUniverse.push('HOTMOVERX');
          (marketDataWorker as any).subscribedAtMs.set('HOTMOVERX', admissionMs);
        }
        return ret;
      }) as any);

      const sinceIso = new Date().toISOString();
      await quantSignalAgent.triggerNow(); // cycle 1 — HOTMOVERX admitted mid-cycle
      expect(admitted).toBe(true);
      expect(marketDataWorker.getSubscribedAtMs('HOTMOVERX')).toBe(admissionMs);

      const completedAfter1 = await readEvents('QUANT_CYCLE_COMPLETED');
      const c1 = payloadOf(completedAfter1[completedAfter1.length - 1]);
      // Snapshot fixation is the current design (see header): the mid-cycle admission is NOT in
      // cycle 1's attempt set — but it must not vanish either.
      expect(c1.attemptedSymbols).not.toContain('HOTMOVERX');
      expect((await assessmentRowsSince('HOTMOVERX', sinceIso)).length).toBe(0);

      await quantSignalAgent.triggerNow(); // cycle 2 — must pick up the late admission
      const completedAfter2 = await readEvents('QUANT_CYCLE_COMPLETED');
      const c2 = payloadOf(completedAfter2[completedAfter2.length - 1]);
      expect(c2.cycleId).not.toBe(c1.cycleId);
      expect(c2.reason).toBe('COMPLETED');
      const startedAfter2 = await readEvents('QUANT_CYCLE_STARTED');
      const s2 = payloadOf(startedAfter2[startedAfter2.length - 1]);
      expect(s2.cycleId).toBe(c2.cycleId);
      expect(s2.universeSize).toBe(6);
      expect(c2.attemptedSymbols).toContain('HOTMOVERX');

      // LATE-ADMISSION SLA: subscribedAtMs → first terminal outcome ≤ one full cycle duration.
      const finished2 = (await readEvents('QUANT_SYMBOL_EVAL_FINISHED')).filter(
        (r) => payloadOf(r).cycleId === c2.cycleId,
      );
      const hotFinish = finished2.map(payloadOf).find((p) => p._symbol === 'HOTMOVERX');
      expect(hotFinish).toBeTruthy();
      expect(hotFinish.outcome).toBe('ASSESSED');
      expect((await assessmentRowsSince('HOTMOVERX', sinceIso)).length).toBe(1);
      const latencyMs = hotFinish._ts - marketDataWorker.getSubscribedAtMs('HOTMOVERX');
      expect(latencyMs).toBeGreaterThanOrEqual(0);
      expect(latencyMs).toBeLessThanOrEqual(fullCycleSlaMs(6));
    },
  );
});
