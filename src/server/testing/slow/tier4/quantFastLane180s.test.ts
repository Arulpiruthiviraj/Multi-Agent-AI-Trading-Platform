/**
 * ==========================================================
 * Phase 3 certification — 180s high-priority admission SLA (EXPECTED-FAIL)
 *
 * What this pins: the mission target that a newly admitted HOT mover BEGINS quant
 * assessment (QUANT_SYMBOL_EVAL_STARTED) within 180 seconds of admission, under load:
 * a 100-symbol universe, a slow provider (2s per symbol fetch), and churn (staggered
 * hot admissions plus mid-cycle universe rotation).
 *
 * CURRENT STATUS: EXPECTED-FAIL (`it.fails`). The current design has no mover fast
 * path — the universe snapshot is fixed at cycle top (see quantSchedulerSla.test.ts
 * test 3: mid-cycle admissions land in the NEXT cycle), so HOT_MOVER_X admitted
 * mid-cycle never receives a QUANT_SYMBOL_EVAL_STARTED inside the 180s window. The
 * design for the lane that would close this gap is
 * docs/testing/FAST_LANE_DESIGN.md (DEFERRED — QUANT_RESEARCH_REQUIRED, not built:
 * the 180s start guarantee is unprovable while per-symbol provider latency is
 * unbounded, and the fixes are scheduler architecture changes with unverifiable
 * risks).
 *
 * Honesty contract for this file:
 * - `it.fails` keeps the suite green while the gap is open AND acts as a tripwire:
 *   if the assertion ever PASSES (the lane got built), vitest reports the test as
 *   failed ("expected to fail but passed") — that is the signal to convert it to a
 *   normal `it` and extend it per FAST_LANE_DESIGN.md §9.
 * - The ONLY assertion allowed to fail here is the 180s one. Harness sanity
 *   (cycle actually running, admission actually recorded) is checked with explicit
 *   throws BEFORE the SLA assertion so a broken harness is loud in logs even though
 *   `it.fails` swallows the failure.
 * - Seeded bars are CERTIFICATION_FIXTURE, pattern-free (same helper shape as
 *   quantSchedulerSla.test.ts); the test asserts on SCHEDULING, never on strategy
 *   decisions. No lifecycle rows seeded, no thresholds touched, isolated temp DB,
 *   PAPER_TRADING_ONLY=true.
 *
 * Labels: COMPONENT (real runCycle, real evaluateSymbol, real SQLite, stubbed
 * universe + slowed provider); EXPECTED_FAIL / QUANT_RESEARCH_REQUIRED.
 * Tier: SLOW / NIGHTLY — lives under src/server/testing/slow/tier4 so the
 * tier1 exclusion for testing/slow paths keeps this ~4-minute test out of
 * the fast pre-market gate.
 * ==========================================================
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';

let db: any;
let schema: any;
let marketDataWorker: any;
let quantSignalAgent: any;
let historicalDataGateway: any;
let structuredLogger: any;
let flushObservabilityStore: () => Promise<void>;
let tradingSafety: any;

const DAY_MS = 86_400_000;
const BENCHMARK_SYMBOLS = ['SPY', 'QQQ', 'IWM'];
const SLOW_PROVIDER_DELAY_MS = 2000; // the "slow provider": 2s per symbol fetch
const HOT_SLA_MS = 180_000; // the mission target: admission -> assessment start <= 180s
const UNIVERSE_SIZE = 100;

async function seedDailyBars(symbol: string, count: number, basePrice: number): Promise<void> {
  const dayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
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

async function readEvents(eventType: string): Promise<any[]> {
  await flushObservabilityStore();
  return db
    .select()
    .from(schema.observabilityEvents)
    .all()
    .filter((r: any) => r.eventType === eventType);
}

const payloadOf = (row: any): any => ({ ...parsePayload(row), _ts: row.ts, _symbol: row.symbol });

beforeAll(async () => {
  const tmpDbPath = path.join(os.tmpdir(), `argus_quant_fastlane_180s_${Date.now()}_${process.pid}.db`);
  process.env.ARGUS_DB_PATH = tmpDbPath;
  process.env.PAPER_TRADING_ONLY = 'true';
  process.env.QUANT_ENGINE_ENABLED = 'true';
  process.env.ARGUS_QUANT_INDEPENDENT_QUALIFICATION_ENABLED = 'false';
  process.env.ARGUS_STRATEGY_SELECTION_CONFLUENCE_GUARD_ENABLED = 'false';

  ({ db } = await import('../../../db'));
  schema = await import('../../../db/schema');
  ({ marketDataWorker } = await import('../../../services/MarketDataWorker'));
  ({ quantSignalAgent } = await import('../../../services/QuantSignalAgent'));
  ({ historicalDataGateway } = await import('../../../engines/backtest/HistoricalDataGateway'));
  ({ structuredLogger } = await import('../../../observability/StructuredLogger'));
  ({ flushObservabilityStore } = await import('../../../observability/ObservabilityStore'));
  ({ tradingSafety } = await import('../../../config/tradingSafety'));

  for (const sym of BENCHMARK_SYMBOLS) await seedDailyBars(sym, 400, 100);
}, 180_000);

afterEach(() => {
  vi.restoreAllMocks();
  if (quantSignalAgent) (quantSignalAgent as any).nextCycleSymbol = null;
});

describe('quant fast-lane 180s admission SLA (EXPECTED-FAIL — see file header)', () => {
  it.fails(
    'HOT_MOVER_X admitted mid-cycle begins assessment within 180s under load (100 symbols, slow provider, churn)',
    { timeout: 300_000 },
    async () => {
      // --- load: 100 symbols with enough real bars to take the ASSESSED path (>= 60) ---
      const universe: string[] = Array.from({ length: UNIVERSE_SIZE }, (_, i) => `SYM${String(i + 1).padStart(3, '0')}`);
      for (const sym of universe) await seedDailyBars(sym, 70, 100);
      for (const sym of ['HOTMOVERX', 'HOTMOVER2', 'HOTMOVER3']) await seedDailyBars(sym, 70, 100);

      const liveUniverse = [...universe];
      vi.spyOn(marketDataWorker, 'getActiveSymbols').mockImplementation(() => [...liveUniverse]);

      // --- slow provider: 2s per symbol fetch (benchmarks stay cache-fast so the cycle
      //     duration stays predictable at ~100 x 2s = ~200s, longer than the 180s target) ---
      const realEnsure = historicalDataGateway.ensureBars.bind(historicalDataGateway);
      vi.spyOn(historicalDataGateway, 'ensureBars').mockImplementation(
        async (sym: string, tf: string, sMs: number, eMs: number) => {
          if (!BENCHMARK_SYMBOLS.includes(sym)) {
            await new Promise((r) => setTimeout(r, SLOW_PROVIDER_DELAY_MS));
          }
          return realEnsure(sym, tf, sMs, eMs);
        },
      );

      // --- churn: staggered hot admissions + universe rotation, all tied to STARTED-event
      //     counts (deterministic, no sleeps). HOTMOVERX is admitted strictly after the
      //     cycle's once-per-cycle universe snapshot (first STARTED), i.e. mid-cycle. ---
      let startedCount = 0;
      let admissionMs = 0;
      const realInfo = structuredLogger.info.bind(structuredLogger);
      vi.spyOn(structuredLogger, 'info').mockImplementation(((msg: string, fields?: any) => {
        const ret = realInfo(msg, fields);
        if (msg === 'quant_symbol_eval_started') {
          startedCount++;
          if (startedCount === 1) {
            admissionMs = Date.now();
            liveUniverse.push('HOTMOVERX');
            (marketDataWorker as any).subscribedAtMs.set('HOTMOVERX', admissionMs);
          } else if (startedCount === 10) {
            liveUniverse.push('HOTMOVER2');
            (marketDataWorker as any).subscribedAtMs.set('HOTMOVER2', Date.now());
          } else if (startedCount === 25) {
            liveUniverse.push('HOTMOVER3');
            (marketDataWorker as any).subscribedAtMs.set('HOTMOVER3', Date.now());
          } else if (startedCount === 40) {
            // universe rotation mid-cycle: two symbols leave, one new one joins
            const a = liveUniverse.indexOf('SYM050');
            if (a >= 0) liveUniverse.splice(a, 1);
            const b = liveUniverse.indexOf('SYM051');
            if (b >= 0) liveUniverse.splice(b, 1);
            liveUniverse.push('SYM050B');
          }
        }
        return ret;
      }) as any);

      // --- harness sanity BEFORE the SLA assertion: the cycle really ran, the admission
      //     really happened mid-cycle (loud in logs even though it.fails swallows failures) ---
      const cycleP = quantSignalAgent.triggerNow();
      cycleP.catch(() => {});

      const deadlineMs = () => admissionMs + HOT_SLA_MS;
      let hotStartedAt: number | null = null;
      // Wait until HOTMOVERX gets a QUANT_SYMBOL_EVAL_STARTED or the 180s window expires.
      // Poll on wall-clock; admissionMs is set synchronously inside the first STARTED event.
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        if (admissionMs === 0) {
          throw new Error(
            '[FAST_LANE_180S HARNESS] admission never recorded — the first quant_symbol_eval_started never fired; the harness is broken, not the SLA.',
          );
        }
        const started = await readEvents('QUANT_SYMBOL_EVAL_STARTED');
        const hit = started.map(payloadOf).find((p) => p._symbol === 'HOTMOVERX' && p._ts >= admissionMs);
        if (hit) {
          hotStartedAt = hit._ts;
          break;
        }
        if (Date.now() >= deadlineMs()) break;
      }

      if (hotStartedAt === null) {
        console.error(
          `[FAST_LANE_180S] QUANT_RESEARCH_REQUIRED — HOT_MOVER_X admitted at ${new Date(admissionMs).toISOString()} ` +
            `received NO QUANT_SYMBOL_EVAL_STARTED within ${HOT_SLA_MS / 1000}s under load ` +
            `(${UNIVERSE_SIZE} symbols, ${SLOW_PROVIDER_DELAY_MS}ms/provider fetch, churn). ` +
            `Current design: mid-cycle admissions wait for the next cycle (snapshot fixation). ` +
            `See docs/testing/FAST_LANE_DESIGN.md.`,
        );
      } else {
        console.error(
          `[FAST_LANE_180S] UNEXPECTED PASS — HOT_MOVER_X began assessment ` +
            `${hotStartedAt - admissionMs}ms after admission. The fast lane may have been implemented: ` +
            `convert this it.fails to a normal it per docs/testing/FAST_LANE_DESIGN.md §9.`,
        );
      }

      // Let the background cycle finish cleanly (mocks still installed; ~200s total cycle,
      // most of it already elapsed during the 180s poll window).
      await cycleP;

      // --- THE SLA ASSERTION (the only assertion allowed to fail in this file) ---
      expect(
        hotStartedAt,
        `HOT_MOVER_X admitted mid-cycle began assessment within ${HOT_SLA_MS / 1000}s under load`,
      ).not.toBeNull();
      expect(hotStartedAt! - admissionMs).toBeLessThanOrEqual(HOT_SLA_MS);
    },
  );
});
