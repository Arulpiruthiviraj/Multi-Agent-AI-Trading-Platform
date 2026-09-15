/**
 * P1-A isolated reproduction harness (2026-09-14 overnight remediation, per explicit operator
 * instruction). Classification: OFFLINE-FORENSIC / RESEARCH-ONLY - never imported by the
 * application, never touches the live trading process's own heap or database. Boots a REAL,
 * isolated instance of Argus's core spine (isolated tmp DB, same pattern as
 * ArgusCoreBoot.test.ts) and drives it with a representative synthetic workload through the REAL
 * production entry point (eventBus.emitTradeIdea()) - the same code path TechnicalAgent/
 * KronosEngine/QuantEngine actually use - so this exercises real gating, real ChiefTraderAgent
 * consensus evaluation, real EventStore tracking, and the real structured-logger bridge, not a
 * mock.
 *
 * Method: baseline snapshot -> N paced workload batches (each: forced GC -> snapshot). Emission
 * is PACED under the real production sliding-window cap (tradingSafety.maxTradeIdeasPerMinute,
 * 120/min, src/server/core/pipelineRateLimit.ts) - a first-pass version fired a synchronous burst
 * and >99% of ideas were silently IDEA_RATE_LIMITED before ever reaching ChiefTraderAgent, which
 * only proved the shallow gate was fine, not that the suspected deeper pipeline was exercised.
 * Heap snapshots are taken ONLY in this isolated process (never the trading process) via
 * v8.writeHeapSnapshot(), exactly as instructed. Run with --expose-gc so the forced-GC step is
 * real, not a no-op.
 *
 * Usage: node --expose-gc --max-old-space-size=2048 --import tsx scripts/forensic/reproduce_p1a.ts \
 *          [ideasPerBatch=300] [ideasPerMinute=90] [numBatches=3]
 */
import v8 from 'node:v8';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// First-pass burst (15000 ideas emitted synchronously in ~2s) was NOT a valid workload: real
// production has a hard sliding-window cap (tradingSafety.maxTradeIdeasPerMinute, 120/min,
// src/server/core/pipelineRateLimit.ts) enforced INSIDE eventBus.emit() before an idea ever
// reaches ChiefTraderAgent. A synchronous burst blows through that cap in well under a second,
// so ~99% of "emitted" ideas were actually IDEA_RATE_LIMITED and never touched the deeper
// consensus/calibration/EventStore pipeline at all - which is exactly why that run showed flat
// memory: it was proving the shallow gate is fine, not exercising the suspected pipeline.
// This version paces emission below the real cap so ideas actually clear the gate and run the
// real pipeline, matching how the live incident actually accumulated (over real elapsed time,
// not a synthetic instant burst).
const IDEAS_PER_BATCH = Number(process.argv[2] || '300');
const IDEAS_PER_MINUTE_TARGET = Number(process.argv[3] || '90'); // safety margin under the 120 cap
const IDEA_INTERVAL_MS = Math.ceil(60_000 / IDEAS_PER_MINUTE_TARGET);
const NUM_WORKLOAD_BATCHES = Number(process.argv[4] || '3');
const SNAPSHOT_DIR = path.join(os.tmpdir(), 'argus_p1a_repro');
fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

const SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'AMD', 'QQQ', 'SPY', 'GLD', 'IWM', 'DIA', 'TSLA'];
const AGENTS = ['TechnicalAgent', 'KronosEngine', 'QuantEngine', 'NewsAgent'];
const REASONING_SAMPLES = [
  'Oversold condition. Price breached lower Bollinger Band with RSI at 24.31.',
  'Strong upward trend detected. MACD bullish crossover. RSI at 61.02.',
  JSON.stringify({ source: 'Chronos', model: 'amazon/chronos-t5-mini (local)', timeframe: 'tick', forecastHorizon: 5, expectedMove: '-0.21%', volatility: '0.05%', support: 480.11, resistance: 482.4, lastPrice: 481.2 }),
  'Chronos forecasts SELL (expected move -0.18% over 5 steps, support 200.55, resistance 204.11).',
  'News catalyst detected: earnings beat, positive sentiment score 0.72.',
];

function memMb() {
  const m = process.memoryUsage();
  return { rss: (m.rss / (1024 * 1024)).toFixed(1), heapUsed: (m.heapUsed / (1024 * 1024)).toFixed(1) };
}

function snapshot(label: string): string {
  const file = path.join(SNAPSHOT_DIR, `${label}.heapsnapshot`);
  const start = Date.now();
  v8.writeHeapSnapshot(file);
  console.log(`[snapshot] ${label} -> ${file} (${Date.now() - start}ms, ${(fs.statSync(file).size / (1024 * 1024)).toFixed(1)}MB)`);
  return file;
}

function forceGc(): void {
  if (typeof (global as any).gc === 'function') {
    (global as any).gc();
    (global as any).gc(); // twice - a single call sometimes only runs a minor/scavenge pass
  } else {
    console.warn('[repro] --expose-gc not set - forced GC step is a no-op. Re-run with --expose-gc.');
  }
}

let globalSeq = 0; // monotonic across batches so traceIds/content never repeat identically

async function runWorkloadBatch(n: number): Promise<{ rateLimited: number; emitted: number }> {
  const { eventBus } = await import('../../src/server/core/EventBus');
  const { generateTraceId } = await import('../../src/server/core/traceId');

  let rateLimited = 0;
  let emitted = 0;
  const onLimited = () => { rateLimited += 1; };
  eventBus.subscribe('IDEA_RATE_LIMITED', onLimited);

  for (let i = 0; i < n; i++) {
    const seq = globalSeq++;
    const symbol = SYMBOLS[seq % SYMBOLS.length];
    const agent = AGENTS[seq % AGENTS.length];
    const side = seq % 2 === 0 ? 'BUY' : 'SELL';
    const traceId = generateTraceId(symbol); // real production ID minting, not a fake string
    eventBus.emitTradeIdea({
      traceId,
      symbol,
      side,
      confidence: 0.5 + (seq % 40) / 100,
      reasoning: REASONING_SAMPLES[seq % REASONING_SAMPLES.length],
      agent,
      currentPrice: 100 + (seq % 300),
    });
    emitted += 1;
    // Real pacing, not a burst: stay under the real sliding-window cap
    // (tradingSafety.maxTradeIdeasPerMinute) so ideas actually clear the gate instead of being
    // dropped by IDEA_RATE_LIMITED before ever reaching ChiefTraderAgent.
    await new Promise((r) => setTimeout(r, IDEA_INTERVAL_MS));
  }
  // Let trailing async work (DB inserts, consensus timers, debate calls) settle before measuring.
  await new Promise((r) => setTimeout(r, 3000));
  eventBus.unsubscribe('IDEA_RATE_LIMITED', onLimited);
  return { rateLimited, emitted };
}

async function main() {
  process.env.ARGUS_DB_PATH = path.join(os.tmpdir(), `argus_p1a_repro_${Date.now()}.db`);
  process.env.PAPER_TRADING_ONLY = 'true';
  process.env.ARGUS_DISABLE_HEAP_SNAPSHOTS = 'true'; // this harness takes its OWN snapshots explicitly; don't also let the app's own mechanism fire
  process.env.ARGUS_DISABLE_MARKET_DATA_WS = 'true'; // isolated harness - no real Alpaca/IBKR network connections
  process.env.OPENALICE_ENABLED = 'false';

  // Isolate the session-recovery marker file too (2026-09-14, found via a smoke-test run of this
  // harness that read/almost collided with the LIVE engine's own data/.argus_runtime_session.json
  // - that path defaults to process.cwd()-relative, same cwd this harness runs from, and is
  // shared across processes; RestartSafetyGuard correctly saw the live engine's still-running
  // cleanShutdown:false marker and paused the harness's own Autobot). Point it at a fresh,
  // nonexistent tmp path so loadInterruptedSessionMarker() reads null -> interruptedSession=false,
  // matching the real pattern used by ArgusCoreBoot.restartSafety.test.ts.
  const { setSessionRecoveryPathForTests } = await import('../../src/server/core/sessionRecovery');
  setSessionRecoveryPathForTests(path.join(os.tmpdir(), `argus_p1a_repro_session_${Date.now()}.json`));

  // Seed the persisted settings BEFORE boot - TradingEngine.initialize() reads this row directly,
  // so this is robust against whatever async worker was overwriting a post-boot in-memory
  // override in the first pass of this harness (some background worker re-asserts state from the
  // DB shortly after boot; racing it is fragile - seeding the source of truth is not).
  console.log('Seeding TRADING_ENABLED + Autobot into the isolated settings row...');
  const { db: predb } = await import('../../src/server/db');
  const schema = await import('../../src/server/db/schema');
  await predb.insert(schema.settings).values({
    tradingMode: 'PAPER', riskLevel: 'Medium', budget: 100000, strategy: 'ADAPTIVE_MULTI_STRATEGY',
    maxTradeSize: 3000, dailyLossLimit: 5000, takeProfitPct: 15, trailingStopPct: 5,
    minAiConfidence: 75, adversarialDebateMode: true, autoBotEnabled: true,
    tradingState: 'TRADING_ENABLED',
  } as any);

  console.log('Booting isolated Argus core (tmp DB, not the live database)...');
  const { bootArgusCore } = await import('../../src/server/core/ArgusCoreBoot');
  await bootArgusCore();
  console.log('Boot complete. Settling...');
  await new Promise((r) => setTimeout(r, 3000));

  forceGc();
  const baselineMem = memMb();
  console.log(`\n[baseline] mem=${JSON.stringify(baselineMem)}`);
  const baselineFile = snapshot('baseline');

  console.log(
    `\nPacing: ${IDEAS_PER_BATCH} ideas/batch @ ~${IDEAS_PER_MINUTE_TARGET}/min ` +
    `(interval ${IDEA_INTERVAL_MS}ms, cap is ${120}/min real production limit) x ${NUM_WORKLOAD_BATCHES} batches`
  );

  const results: Array<{ label: string; mem: ReturnType<typeof memMb>; file: string; rateLimited: number; emitted: number }> = [
    { label: 'baseline', mem: baselineMem, file: baselineFile, rateLimited: 0, emitted: 0 },
  ];

  for (let b = 1; b <= NUM_WORKLOAD_BATCHES; b++) {
    console.log(`\n=== Workload batch ${b}/${NUM_WORKLOAD_BATCHES}: ${IDEAS_PER_BATCH} paced synthetic ideas ===`);
    const t0 = Date.now();
    const { rateLimited, emitted } = await runWorkloadBatch(IDEAS_PER_BATCH);
    console.log(`Batch ${b} done in ${Date.now() - t0}ms. emitted=${emitted} rateLimited=${rateLimited} mem (pre-GC)=${JSON.stringify(memMb())}`);
    forceGc();
    await new Promise((r) => setTimeout(r, 500));
    const mem = memMb();
    console.log(`mem (post-GC)=${JSON.stringify(mem)}`);
    const file = snapshot(`after-batch${b}-postgc`);
    results.push({ label: `after-batch${b}`, mem, file, rateLimited, emitted });
  }

  console.log('\n=== Summary ===');
  for (const r of results) {
    console.log(`${r.label.padEnd(16)} rss=${r.mem.rss}MB heapUsed=${r.mem.heapUsed}MB rateLimited=${r.rateLimited} -> ${r.file}`);
  }
  const totalEmitted = IDEAS_PER_BATCH * NUM_WORKLOAD_BATCHES;
  const totalRateLimited = results.reduce((s, r) => s + r.rateLimited, 0);
  console.log(`\nTotal synthetic ideas attempted: ${totalEmitted} (rate-limited: ${totalRateLimited}, cleared gate: ${totalEmitted - totalRateLimited})`);
  console.log('If post-GC RSS/heapUsed grows batch-over-batch (not just baseline->batch1, but');
  console.log('continuing batch1->batch2->batch3...) and this holds AFTER forced GC, that is real');
  console.log('evidence of genuine monotonic retention in this exact pipeline - not GC timing.');
  console.log('If it stabilizes (later batches ~= earlier batches post-GC), this pipeline is NOT the leak.');

  process.exit(0); // must exit - do not linger as a second DB writer against the tmp file
}

main().catch((e) => { console.error('FAILED', e); process.exit(1); });
