/**
 * P1-A targeted reproduction: outcome-evaluator overlap experiment (2026-09-14, per explicit
 * operator experimental design). Classification: OFFLINE-FORENSIC / RESEARCH-ONLY - isolated tmp
 * DB, never touches the live engine's database or process.
 *
 * Context: retainer-path analysis of the preserved P1-B incident snapshot (2.04GB) found millions
 * of live `string` nodes with content "BUY"/"SELL"/ticker symbols/prediction-shaped values,
 * retained via property edges named side/rawSide/winningSide/action/symbol/prediction from a huge
 * number of distinct `Object` nodes, with retainer-chain code context naming
 * evaluateMultiHorizonOutcomesForPrediction/evaluatePending/classifyVote/computeShadowConsensus.
 * Reading those functions' source found a real, unmitigated pattern: PredictionOutcomeEvaluator.ts
 * and MultiHorizonOutcomeEvaluator.ts both run on a bare setInterval (no overlap guard - grepped
 * all four "outcome evaluator" classes for isRunning/inFlight/mutex, none exists) and do an
 * UNBOUNDED `db.select().from(table).all()` every cycle. Live DB row counts at time of writing:
 * agent_predictions 108,563 / prediction_outcomes 81,741 / kronos_predictions 15,339 - all
 * monotonically growing. A second candidate was found while building this harness:
 * HistoricalDataGateway.memoryBars is a Map keyed by symbol|timeframe|hourBucket that is SET on
 * every getBars() call (hit or miss) but only DELETED when persistBars() successfully writes new
 * bars for that exact window - for synthetic/no-data symbols (or any window that never gets a
 * successful fetch), the entry has no active eviction path at all beyond a lazy expiresAt check
 * that only fires if the SAME key is read again, which is unlikely across 100K+ predictions spread
 * over many distinct hours.
 *
 * This script does NOT wait for real setInterval firings (non-deterministic, slow). It calls
 * evaluatePending() directly under controlled concurrency (Promise.all for N=1/2/3 simultaneous
 * invocations) - this directly and deterministically tests "what happens if cycle N+1 starts while
 * cycle N's working set is still referenced," which is exactly the failure mode a >5min real cycle
 * would trigger via the bare setInterval in production, without needing to wait ~15+ minutes of
 * real wall-clock time per trial.
 *
 * Usage: node --expose-gc --max-old-space-size=4096 --import tsx \
 *   scripts/forensic/reproduce_p1a_outcome_evaluators.ts [predictionRows=108563] [outcomeRows=81741] [kronosRows=15339]
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const PREDICTION_ROWS = Number(process.argv[2] || '108563');
const OUTCOME_ROWS = Number(process.argv[3] || '81741');
const KRONOS_ROWS = Number(process.argv[4] || '15339');
const SEED_BATCH_SIZE = 1000;

const SYMBOLS = ['AAPL','MSFT','NVDA','AMD','QQQ','SPY','GLD','IWM','DIA','TSLA','GOOGL','META','AMZN','NFLX','CRM',
  'SOXL','S','CRWD','PANW','RBLX','OKTA','COIN','ARM','LNTH','FCEL','EQPT','PRIM','AVEX','OKLO'];
const AGENTS = ['TechnicalAgent', 'KronosEngine', 'QuantEngine', 'NewsAgent', 'FundamentalAgent', 'MacroAgent'];
const SIDES = ['BUY', 'SELL', 'HOLD'];
const REASONING_SAMPLES = [
  'Oversold condition. Price breached lower Bollinger Band with RSI at 24.31.',
  'Strong upward trend detected. MACD bullish crossover. RSI at 61.02.',
  'QuantEngine: no directional regime signal for SIDEWAYS_RANGE - falling back to RANGE_REVERSION.',
  'QuantEngine: BULLISH_TREND regime (trendStrength 51, marketStructure TRENDING, volatility elevated).',
  'Chronos forecasts SELL (expected move -0.18% over 5 steps, support 200.55, resistance 204.11).',
  'News catalyst detected: earnings beat, positive sentiment score 0.72.',
];

function memMb() {
  const m = process.memoryUsage();
  return { rss: +(m.rss / (1024 * 1024)).toFixed(1), heapUsed: +(m.heapUsed / (1024 * 1024)).toFixed(1) };
}
function forceGc(): void {
  if (typeof (global as any).gc === 'function') { (global as any).gc(); (global as any).gc(); }
  else console.warn('[repro] --expose-gc not set - forced GC is a no-op.');
}
function randOf<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function randomTraceId(symbol: string): string {
  return `trace_${symbol}_${1700000000 + Math.floor(Math.random() * 90000000)}_${Math.random().toString(16).slice(2, 6)}`;
}
// Spread timestamps over the last 30 real days so hour-buckets are mostly distinct - matching
// production's real spread, not a tight synthetic cluster that would artificially help the cache.
function randomTimestampMs(): number {
  const now = Date.now();
  return now - Math.floor(Math.random() * 30 * 24 * 60 * 60 * 1000);
}

interface Marker {
  label: string;
  cycleStartMs: number;
  cycleEndMs: number;
  durationMs: number;
  memoryBarsMapSizeBefore: number;
  memoryBarsMapSizeAfter: number;
  heapBefore: ReturnType<typeof memMb>;
  heapAfter: ReturnType<typeof memMb>;
  heapAfterGc: ReturnType<typeof memMb>;
}
const markers: Marker[] = [];

async function main() {
  const dbPath = path.join(os.tmpdir(), `argus_p1a_outcome_repro_${Date.now()}.db`);
  process.env.ARGUS_DB_PATH = dbPath;
  process.env.PAPER_TRADING_ONLY = 'true';
  process.env.ARGUS_DISABLE_MARKET_DATA_WS = 'true';
  process.env.ARGUS_DISABLE_HEAP_SNAPSHOTS = 'true';
  process.env.OPENALICE_ENABLED = 'false';

  console.log(`=== A. Baseline (isolated process, isolated DB ${dbPath}, no core boot - direct evaluator instrumentation only) ===`);
  const { db } = await import('../../src/server/db');
  const schema = await import('../../src/server/db/schema');
  forceGc();
  console.log(`baseline mem=${JSON.stringify(memMb())}`);

  console.log(`\n=== B. Seeding production-scale tables: ${PREDICTION_ROWS} agent_predictions, ${OUTCOME_ROWS} prediction_outcomes, ${KRONOS_ROWS} kronos_predictions ===`);
  const seedStart = Date.now();

  const predictionIds: string[] = [];
  for (let batchStart = 0; batchStart < PREDICTION_ROWS; batchStart += SEED_BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + SEED_BATCH_SIZE, PREDICTION_ROWS);
    const rows = [];
    for (let i = batchStart; i < batchEnd; i++) {
      const symbol = randOf(SYMBOLS);
      const id = `pred_${i}_${Math.random().toString(16).slice(2, 10)}`;
      predictionIds.push(id);
      rows.push({
        id,
        agentName: randOf(AGENTS),
        symbol,
        prediction: randOf(SIDES),
        confidence: 0.5 + Math.random() * 0.45,
        reasoning: randOf(REASONING_SAMPLES),
        timestamp: new Date(randomTimestampMs()).toISOString(),
        traceId: randomTraceId(symbol),
        aiCallId: null,
        provider: null,
        latencyMs: null,
        regime: null,
        strategyId: null,
      });
    }
    await db.insert(schema.agentPredictions).values(rows as any);
    if (batchStart % 20000 === 0) console.log(`  agent_predictions: ${batchEnd}/${PREDICTION_ROWS}`);
  }

  // ~75% of predictions already "done" (have a matching outcome row) - the remainder is the real
  // per-cycle evaluation work, matching production's own 81,741/108,563 ratio (~75%).
  const doneCount = Math.min(OUTCOME_ROWS, predictionIds.length);
  for (let batchStart = 0; batchStart < doneCount; batchStart += SEED_BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + SEED_BATCH_SIZE, doneCount);
    const rows = [];
    for (let i = batchStart; i < batchEnd; i++) {
      rows.push({
        predictionId: predictionIds[i],
        sourceTable: 'agent_predictions',
        symbol: randOf(SYMBOLS),
        actualPrice: 100 + Math.random() * 300,
        actualReturn: (Math.random() - 0.5) * 0.05,
        actualDirection: randOf(['UP', 'DOWN', 'FLAT']),
        mfe: Math.random() * 0.03,
        mae: -Math.random() * 0.03,
        pnl: (Math.random() - 0.5) * 100,
        outcome: randOf(['WIN', 'LOSS', 'N_A']),
        evaluatedAt: new Date().toISOString(),
      });
    }
    await db.insert(schema.predictionOutcomes).values(rows as any).onConflictDoNothing();
    if (batchStart % 20000 === 0) console.log(`  prediction_outcomes: ${batchEnd}/${doneCount}`);
  }

  for (let batchStart = 0; batchStart < KRONOS_ROWS; batchStart += SEED_BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + SEED_BATCH_SIZE, KRONOS_ROWS);
    const rows = [];
    for (let i = batchStart; i < batchEnd; i++) {
      const symbol = randOf(SYMBOLS);
      rows.push({
        timeframe: '1m',
        symbol,
        prediction: randOf(SIDES),
        confidence: Math.floor(50 + Math.random() * 50),
        forecastHorizon: 5,
        expectedMove: `${(Math.random() * 2 - 1).toFixed(2)}%`,
        volatility: `${(Math.random() * 2).toFixed(2)}%`,
        support: 100 + Math.random() * 200,
        resistance: 200 + Math.random() * 300,
        model: 'amazon/chronos-t5-mini (local)',
        predictedOhlc: null, marketStructure: null, momentum: null, actualResult: null,
        mae: null, rmse: null, mape: null, directionalAccuracy: null,
        timestamp: new Date(randomTimestampMs()).toISOString(),
        traceId: randomTraceId(symbol), transactionId: null,
        inputRealizedVolatility: null, inputMeanAbsReturn: null, inputRangeRatio: null,
      });
    }
    await db.insert(schema.kronosPredictions).values(rows as any);
    if (batchStart % 20000 === 0) console.log(`  kronos_predictions: ${batchEnd}/${KRONOS_ROWS}`);
  }
  console.log(`Seeding done in ${Date.now() - seedStart}ms`);

  forceGc();
  const postSeedMem = memMb();
  console.log(`post-seed mem (after forced GC)=${JSON.stringify(postSeedMem)}`);

  // ===== Query-only cost, isolated from row processing (operator's specific request) =====
  console.log(`\n=== Query-only cost: db.select().from(agentPredictions).all() alone ===`);
  {
    const t0 = Date.now();
    let rows: any = await db.select().from(schema.agentPredictions).all();
    const t1 = Date.now();
    const heldMem = memMb();
    console.log(`query took ${t1 - t0}ms, rowsFetched=${rows.length}, mem-while-held=${JSON.stringify(heldMem)}`);
    forceGc();
    const heldPostGc = memMb();
    console.log(`mem-while-held-after-forced-GC (should NOT drop much - still referenced)=${JSON.stringify(heldPostGc)}`);
    rows = null; // drop the only reference
    forceGc();
    const releasedPostGc = memMb();
    console.log(`mem-after-dereference-and-forced-GC (should drop close to post-seed baseline if truly release-able)=${JSON.stringify(releasedPostGc)}`);
  }

  const { historicalDataGateway } = await import('../../src/server/engines/backtest/HistoricalDataGateway');
  const memoryBarsMap = (): number => (historicalDataGateway as any).memoryBars?.size ?? -1;

  async function runInstrumented(label: string, fn: () => Promise<void>, evaluator?: { getMetrics: () => any }): Promise<Marker> {
    const before = memMb();
    const mapBefore = memoryBarsMap();
    const t0 = Date.now();
    await fn();
    const t1 = Date.now();
    const after = memMb();
    forceGc();
    const afterGc = memMb();
    const mapAfter = memoryBarsMap();
    const m: Marker = {
      label, cycleStartMs: t0, cycleEndMs: t1, durationMs: t1 - t0,
      memoryBarsMapSizeBefore: mapBefore, memoryBarsMapSizeAfter: mapAfter,
      heapBefore: before, heapAfter: after, heapAfterGc: afterGc,
    };
    markers.push(m);
    const cycleInfo = evaluator ? (() => { const met = evaluator.getMetrics(); return ` | fetched=${met.lastCycle?.rowsFetched ?? '?'} processed=${met.lastCycle?.rowsProcessed ?? '?'} written=${met.lastCycle?.rowsWritten ?? '?'} skippedInFlight=${met.totalSkippedInFlight ?? '?'}`; })() : '';
    console.log(`[${label}] duration=${m.durationMs}ms memoryBarsMap ${mapBefore}->${mapAfter} heap ${before.heapUsed}MB->${after.heapUsed}MB->(GC)${afterGc.heapUsed}MB rss(GC)=${afterGc.rss}MB${cycleInfo}`);
    return m;
  }

  console.log(`\n=== C/D. Single-evaluator, SUSTAINED sequential cycles (not just 3 - draining the realistic backlog, per the operator's explicit "bounded RSS over sustained workload, not merely the six-way test got smaller" acceptance criterion) ===`);
  const { PredictionOutcomeEvaluator } = await import('../../src/server/services/PredictionOutcomeEvaluator');
  const { MultiHorizonOutcomeEvaluator } = await import('../../src/server/services/MultiHorizonOutcomeEvaluator');

  const SUSTAINED_CYCLES = 20;
  console.log(`\n--- PredictionOutcomeEvaluator alone: ${SUSTAINED_CYCLES} sequential cycles ---`);
  const poe = new PredictionOutcomeEvaluator();
  for (let i = 1; i <= SUSTAINED_CYCLES; i++) {
    await runInstrumented(`POE-sequential-cycle-${i}`, () => poe.evaluatePending(), poe);
  }

  console.log(`\n--- MultiHorizonOutcomeEvaluator alone: ${SUSTAINED_CYCLES} sequential cycles ---`);
  const mhoe = new MultiHorizonOutcomeEvaluator();
  for (let i = 1; i <= SUSTAINED_CYCLES; i++) {
    await runInstrumented(`MHOE-sequential-cycle-${i}`, () => mhoe.evaluatePending(), mhoe);
  }

  console.log(`\n=== The overlap experiment: N concurrent invocations via Promise.all (simulates setInterval firing again before the previous cycle resolved) - Patch A's single-flight guard should now coalesce these to exactly 1 real run each, visible via totalSkippedInFlight below ===`);
  for (const n of [2, 3]) {
    const poeN = new PredictionOutcomeEvaluator();
    await runInstrumented(`POE-CONCURRENT-x${n}`, () => Promise.all(Array.from({ length: n }, () => poeN.evaluatePending())).then(() => undefined), poeN);
  }
  for (const n of [2, 3]) {
    const mhoeN = new MultiHorizonOutcomeEvaluator();
    await runInstrumented(`MHOE-CONCURRENT-x${n}`, () => Promise.all(Array.from({ length: n }, () => mhoeN.evaluatePending())).then(() => undefined), mhoeN);
  }

  console.log(`\n=== Both evaluators together, concurrently (production-realistic: both real setIntervals fire on the same 300000ms cadence) ===`);
  {
    const poeBoth = new PredictionOutcomeEvaluator();
    const mhoeBoth = new MultiHorizonOutcomeEvaluator();
    await runInstrumented('BOTH-concurrent-x1-each', () => Promise.all([poeBoth.evaluatePending(), mhoeBoth.evaluatePending()]).then(() => undefined));
  }
  {
    const poeBoth3 = new PredictionOutcomeEvaluator();
    const mhoeBoth3 = new MultiHorizonOutcomeEvaluator();
    await runInstrumented('BOTH-CONCURRENT-x3-each', () => Promise.all([
      poeBoth3.evaluatePending(), poeBoth3.evaluatePending(), poeBoth3.evaluatePending(),
      mhoeBoth3.evaluatePending(), mhoeBoth3.evaluatePending(), mhoeBoth3.evaluatePending(),
    ]).then(() => undefined));
  }

  console.log('\n=== Summary table ===');
  console.log('label'.padEnd(24), 'durMs'.padStart(8), 'mapB->A'.padStart(14), 'heapB'.padStart(8), 'heapA'.padStart(8), 'heapGC'.padStart(8), 'rssGC'.padStart(8));
  for (const m of markers) {
    console.log(
      m.label.padEnd(24),
      String(m.durationMs).padStart(8),
      `${m.memoryBarsMapSizeBefore}->${m.memoryBarsMapSizeAfter}`.padStart(14),
      String(m.heapBefore.heapUsed).padStart(8),
      String(m.heapAfter.heapUsed).padStart(8),
      String(m.heapAfterGc.heapUsed).padStart(8),
      String(m.heapAfterGc.rss).padStart(8),
    );
  }
  console.log('\nInterpretation: if heapAfterGc climbs monotonically across POE/MHOE-sequential-cycle-1/2/3');
  console.log('(i.e. cycle 2 GC-floor > cycle 1 GC-floor > baseline), sequential cycles alone retain');
  console.log('something even without overlap. If CONCURRENT-x2/x3 heapAfterGc is meaningfully higher');
  console.log('than sequential (roughly Nx a single cycle working set instead of returning close to');
  console.log('baseline), that is direct evidence of overlap amplification. If memoryBarsMap size keeps');
  console.log('growing and never shrinks across cycles, that Map has no working eviction path.');

  const outFile = path.join(os.tmpdir(), `argus_p1a_outcome_markers_${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(markers, null, 2));
  console.log(`\nFull marker data: ${outFile}`);

  process.exit(0);
}

main().catch((e) => { console.error('FAILED', e); process.exit(1); });
