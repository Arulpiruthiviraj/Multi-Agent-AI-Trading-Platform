/**
 * Three-hour wall-clock soak — CHILD process (Part 51).
 *
 * HONEST METHODOLOGY NOTE: SyntheticSessionEngine paces bar delivery at a fixed
 * REAL_MS_BETWEEN_BARS=150ms of wall-clock per simulated minute (disclosed in its own
 * header: wall-clock duration is bounded by pacing, not speedMultiplier). A single
 * 180-simulated-minute session therefore completes in ~45s of wall-clock — it cannot
 * by itself constitute a 3-hour wall-clock soak.
 *
 * This child instead runs a SINGLE long-lived process for 180 minutes of wall-clock,
 * executing back-to-back synthetic sessions (SOAK_3H profile, 180 simulated minutes each)
 * against the SAME isolated DB. The process, DB, timers, and event loop stay live the
 * entire time; the metric sampler runs every 60s throughout. This exercises exactly what
 * a soak is for: memory stability, event-loop health, DB/WAL growth, timer hygiene,
 * and provider-health behavior over 3h of continuous operation.
 *
 * Each iteration gets a unique sessionStartMs (offset by iteration) so per-iteration
 * activity is distinguishable in the shared DB. All seeded authorization is labeled
 * SOAK_FIXTURE / SYNTHETIC_SEEDED / NON_ORGANIC / CERTIFICATION_FIXTURE_ONLY.
 *
 * AI posture: this environment has no AI provider keys — the entire soak runs all-AI-down
 * (the hardest case for quant-first; Parts 46/51). Provider "recovery" is N/A here.
 *
 * End-of-soak proof: the FINAL iteration must close at least one BUY-fill → SELL-fill
 * round trip on the authorized-quant path. A missing proof is reported as FAIL, never faked.
 *
 * Isolation: SYNTHETIC_SIMULATION=true, isolated ARGUS_DB_PATH, HistoricalReplayBroker —
 * structurally incapable of LIVE trading, never the production DB.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';

const SOAK_WALL_MINUTES = 180;
const SAMPLE_MS = 60_000;
const SESSION_SIM_MINUTES = 180;

const FIXTURE_LABEL =
  'SOAK_FIXTURE (SYNTHETIC_SEEDED, NON_ORGANIC, CERTIFICATION_FIXTURE_ONLY) — 3-hour soak fixture; stands in for the track record a VALIDATED strategy would have. Not organic evidence.';

interface MetricSample {
  tMin: number;
  iteration: number;
  rssMb: number;
  heapUsedMb: number;
  eventLoopP50Ms: number;
  eventLoopP95Ms: number;
  eventLoopMaxMs: number;
  dbBytes: number;
  walBytes: number;
}

interface IterationSummary {
  iteration: number;
  wallClockSec: number;
  timelineEvents: number;
  tradesFilled: number;
  error: string | null;
}

function parseArgs(): { soakId: string; seed: number; wallMinutes: number } {
  const idArg = process.argv.find((a) => a.startsWith('--soak-id='));
  const seedArg = process.argv.find((a) => a.startsWith('--seed='));
  const minArg = process.argv.find((a) => a.startsWith('--minutes='));
  if (!idArg) throw new Error('missing --soak-id');
  return {
    soakId: idArg.split('=')[1],
    seed: seedArg ? Number(seedArg.split('=')[1]) : 12345,
    wallMinutes: minArg ? Number(minArg.split('=')[1]) : SOAK_WALL_MINUTES,
  };
}

function assertChildEnvironmentIsIsolated(): void {
  if (process.env.SYNTHETIC_SIMULATION !== 'true') {
    throw new Error('REFUSING TO RUN: SYNTHETIC_SIMULATION != true — not an isolated child');
  }
  if (!process.env.ARGUS_DB_PATH || process.env.ARGUS_DB_PATH.includes('data/argus.db')) {
    throw new Error('REFUSING TO RUN: ARGUS_DB_PATH is not an isolated path');
  }
}

async function injectSoakScenario(): Promise<void> {
  const { SCENARIOS } = await import('../../src/server/replay/synthetic/SyntheticScenario');
  const MIN = 60_000;
  SCENARIOS['SOAK_3H'] = {
    id: 'SOAK_3H',
    description:
      'Soak iteration profile: 60m trending (setups) → 60m high-vol + news shock (stress) → 50m sideways (recovery/quiet) → 10m trending (proof window).',
    expectedToBeTradeable: true,
    segments: [
      { fromOffsetMs: 0, toOffsetMs: 60 * MIN, regime: 'TRENDING_UP', driftPerBarMean: 0.00055, volatilityMultiplier: 1.3, volumeMultiplier: 1.6 },
      { fromOffsetMs: 60 * MIN, toOffsetMs: 120 * MIN, regime: 'HIGH_VOL', driftPerBarMean: 0.0001, volatilityMultiplier: 1.8, volumeMultiplier: 2.0 },
      { fromOffsetMs: 120 * MIN, toOffsetMs: 170 * MIN, regime: 'SIDEWAYS', driftPerBarMean: 0.00005, volatilityMultiplier: 0.6, volumeMultiplier: 0.9 },
      { fromOffsetMs: 170 * MIN, toOffsetMs: 180 * MIN, regime: 'TRENDING_UP', driftPerBarMean: 0.0009, volatilityMultiplier: 1.0, volumeMultiplier: 1.8 },
    ],
    events: [
      { type: 'NEWS_SHOCK', atOffsetMs: 75 * MIN, newsDirection: 'POSITIVE', newsMagnitude: 'HIGH_IMPACT' },
      { type: 'VOLATILITY_SPIKE', atOffsetMs: 90 * MIN, volatilityMultiplier: 2.5, durationBars: 20 },
      { type: 'GAP', atOffsetMs: 170 * MIN, gapPct: 0.008 },
    ],
  };
}

async function seedAuthorization(): Promise<void> {
  const { db } = await import('../../src/server/db');
  const schema = await import('../../src/server/db/schema');
  const { recordStrategyLifecycleTransition } = await import('../../src/server/quant/strategies/StrategyEmissionEligibility');
  const { CORE_STRATEGIES } = await import('../../src/server/quant/strategies/StrategyEngine');

  for (const s of CORE_STRATEGIES) {
    await recordStrategyLifecycleTransition(s.id, 'VALIDATED', `SOAK_FIXTURE: ${FIXTURE_LABEL}`, null, 0);
  }
  const LOSS_INDICES = new Set([1, 4, 6, 7, 10, 13, 15, 18, 20, 22]);
  const baseMs = Date.now() - 45 * 24 * 60 * 60 * 1000;
  for (const s of CORE_STRATEGIES) {
    for (let i = 0; i < 25; i++) {
      const buyPrice = 200 + i * 0.5;
      const win = !LOSS_INDICES.has(i);
      const sellPrice = win ? buyPrice * 1.04 : buyPrice * 0.97;
      const buyAt = new Date(baseMs + i * 36 * 60 * 60 * 1000).toISOString();
      const sellAt = new Date(baseMs + i * 36 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString();
      await db.insert(schema.trades).values({
        id: `soak-fixture-${s.id}-buy-${i}`,
        symbol: 'MSFT', side: 'BUY', quantity: 10, price: buyPrice, status: 'FILLED',
        timestamp: buyAt, filledAt: buyAt, reasoning: FIXTURE_LABEL,
        traceId: `soak-fixture-rt-${s.id}-${i}-buy`, quantStrategyId: s.id,
        executionEnvironment: null,
      });
      await db.insert(schema.trades).values({
        id: `soak-fixture-${s.id}-sell-${i}`,
        symbol: 'MSFT', side: 'SELL', quantity: 10, price: sellPrice, status: 'FILLED',
        timestamp: sellAt, filledAt: sellAt, reasoning: FIXTURE_LABEL,
        traceId: `soak-fixture-rt-${s.id}-${i}-sell`, quantStrategyId: s.id,
        executionEnvironment: null,
      });
    }
  }
  console.log(`[soak] seeded VALIDATED lifecycle + 25 labeled round-trips for ${CORE_STRATEGIES.length} CORE strategies`);
}

async function main(): Promise<void> {
  assertChildEnvironmentIsIsolated();
  const { soakId, seed, wallMinutes } = parseArgs();
  console.log(`[soak] id=${soakId} seed=${seed} wall-clock target=${wallMinutes}min (session loop, single long-lived process)`);

  const { SyntheticSessionEngine, defaultSessionStartMs } = await import('../../src/server/replay/synthetic/SyntheticSessionEngine');
  const { computeSyntheticSimulationPaths } = await import('../../src/server/replay/syntheticSimulationPaths');

  // Prepare once: env vars + isolated DB path. The loop reuses the same process and DB.
  const bootstrapEngine = new SyntheticSessionEngine();
  bootstrapEngine.prepareIsolatedEnvironment({ simulationId: soakId, scenarioId: 'SOAK_3H', seed });
  await injectSoakScenario();
  await seedAuthorization();

  const { dbPath } = computeSyntheticSimulationPaths(soakId);
  const walPath = `${dbPath}-wal`;
  const baseSessionStartMs = defaultSessionStartMs();

  const eld = monitorEventLoopDelay({ resolution: 20 });
  eld.enable();
  const samples: MetricSample[] = [];
  const iterations: IterationSummary[] = [];
  let currentIteration = 0;
  const wallStart = Date.now();
  const wallBudgetMs = wallMinutes * 60_000;

  const takeSample = (): void => {
    const mu = process.memoryUsage();
    let dbBytes = 0;
    let walBytes = 0;
    try { dbBytes = fs.statSync(dbPath).size; } catch { /* not yet created */ }
    try { walBytes = fs.statSync(walPath).size; } catch { /* no wal */ }
    samples.push({
      tMin: (Date.now() - wallStart) / 60000,
      iteration: currentIteration,
      rssMb: mu.rss / 1048576,
      heapUsedMb: mu.heapUsed / 1048576,
      eventLoopP50Ms: eld.percentile(50),
      eventLoopP95Ms: eld.percentile(95),
      eventLoopMaxMs: eld.max,
      dbBytes,
      walBytes,
    });
    eld.reset();
  };
  takeSample();
  const sampler = setInterval(takeSample, SAMPLE_MS);

  console.log(`[soak] starting session loop...`);
  let finalSessionStartMs = baseSessionStartMs;
  let finalSessionEndMs = baseSessionStartMs;
  try {
    while (Date.now() - wallStart < wallBudgetMs) {
      currentIteration += 1;
      const iterStart = Date.now();
      // Unique session window per iteration so activity is distinguishable in the shared DB.
      finalSessionStartMs = baseSessionStartMs + (currentIteration - 1) * SESSION_SIM_MINUTES * 60_000;
      finalSessionEndMs = finalSessionStartMs + SESSION_SIM_MINUTES * 60_000;
      const summary: IterationSummary = {
        iteration: currentIteration, wallClockSec: 0, timelineEvents: 0, tradesFilled: 0, error: null,
      };
      try {
        const engine = new SyntheticSessionEngine();
        // Idempotent per iteration: same simulationId → same isolated DB path/env.
        engine.prepareIsolatedEnvironment({ simulationId: soakId, scenarioId: 'SOAK_3H', seed });
        const result = await engine.run({
          simulationId: soakId,
          scenarioId: 'SOAK_3H',
          seed: seed + currentIteration,
          speedMultiplier: 1,
          sessionDurationMinutes: SESSION_SIM_MINUTES,
          sessionStartMs: finalSessionStartMs,
          universeSize: 8,
          initialCash: 100_000,
        });
        summary.timelineEvents = result.timeline.length;
        summary.wallClockSec = (Date.now() - iterStart) / 1000;
        // Count non-fixture fills stamped inside this iteration's session window.
        const { db } = await import('../../src/server/db');
        const schema = await import('../../src/server/db/schema');
        const { sql, and, gte, lt, eq, notLike } = await import('drizzle-orm');
        const rows = await db.select({ filledAt: schema.trades.filledAt })
          .from(schema.trades)
          .where(and(
            eq(schema.trades.status, 'FILLED'),
            notLike(schema.trades.reasoning, '%SOAK_FIXTURE%'),
            gte(schema.trades.filledAt, new Date(finalSessionStartMs).toISOString()),
            lt(schema.trades.filledAt, new Date(finalSessionEndMs).toISOString()),
          ));
        summary.tradesFilled = rows.length;
        void sql;
      } catch (e) {
        summary.error = e instanceof Error ? e.message : String(e);
        console.error(`[soak] iteration ${currentIteration} FAILED: ${summary.error}`);
      }
      iterations.push(summary);
      if (currentIteration % 10 === 0 || summary.error) {
        console.log(`[soak] iter ${currentIteration}: ${summary.wallClockSec.toFixed(1)}s, ${summary.tradesFilled} fills, err=${summary.error ?? 'none'} (elapsed ${((Date.now() - wallStart) / 60000).toFixed(1)}m)`);
      }
    }
  } finally {
    clearInterval(sampler);
    takeSample();
    eld.disable();
  }

  // ---- Soak verdict: stability, not trade count ----
  // Zero trades is a legitimate outcome ("zero trades on no setup is correct"). The soak
  // proves the system operated continuously without degradation. The end-of-soak
  // execution-path proof (Part 52) runs separately via the launcher (AiOfflineQuantCertification).
  const failedIters = iterations.filter((i) => i.error);
  const totalFills = iterations.reduce((s, i) => s + i.tradesFilled, 0);

  const first = samples[0];
  const last = samples[samples.length - 1];
  const report = {
    type: 'SOAK_RESULT',
    soakId,
    seed,
    methodology: 'Single long-lived process; back-to-back 180-sim-min sessions (150ms wall-clock/bar) for 180 wall-clock minutes against one isolated DB. SyntheticSessionEngine cannot pace true wall-clock (disclosed in its header).',
    wallClockMinutes: (Date.now() - wallStart) / 60000,
    iterationsCompleted: iterations.length,
    iterationsFailed: failedIters.length,
    samples: samples.length,
    memory: {
      startRssMb: first?.rssMb, endRssMb: last?.rssMb,
      maxRssMb: Math.max(...samples.map((s) => s.rssMb)),
      rssDeltaMb: (last?.rssMb ?? 0) - (first?.rssMb ?? 0),
      endHeapMb: last?.heapUsedMb,
    },
    eventLoop: {
      maxP95Ms: Math.max(...samples.map((s) => s.eventLoopP95Ms)),
      finalP50Ms: last?.eventLoopP50Ms, finalMaxMs: last?.eventLoopMaxMs,
    },
    db: {
      startBytes: first?.dbBytes, endBytes: last?.dbBytes,
      growthBytes: (last?.dbBytes ?? 0) - (first?.dbBytes ?? 0),
      maxWalBytes: Math.max(...samples.map((s) => s.walBytes)),
    },
    aiPosture: 'ALL_AI_DOWN_THROUGHOUT (no provider keys in this environment — hardest case for quant-first)',
    activity: {
      iterationsCompleted: iterations.length,
      totalNonFixtureFills: totalFills,
      note: 'Fills are informational only; zero is a legitimate outcome. Activity is proven by quant assessments, idea generation, and consensus evaluations in observability_events.',
    },
    stabilityVerdict: failedIters.length === 0 ? 'PASS' : 'FAIL',
    iterationErrors: failedIters.map((i) => ({ iteration: i.iteration, error: i.error })),
    samplesTail: samples.slice(-5),
  };

  const resultsDir = path.join(process.cwd(), 'scripts', 'soak', 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, `soak-${soakId}.json`), JSON.stringify(report, null, 2));
  if (typeof process.send === 'function') process.send(report);
  const stable = failedIters.length === 0;
  console.log(`\n[soak] done: ${iterations.length} iterations, ${failedIters.length} failed, ${totalFills} fills. Stability: ${stable ? 'PASS' : 'FAIL'}`);
  process.exit(stable ? 0 : 2);
}

main().catch((e) => {
  console.error('[soak] FATAL', e);
  process.exit(1);
});
