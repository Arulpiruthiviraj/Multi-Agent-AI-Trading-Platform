/**
 * ==========================================================
 * Script: java_parity_fixtures_phase2
 *
 * Purpose:
 * DB-free fixture generator for JMIG-001 (docs/audits/JAVA_MIGRATION_COMPLETION_PLAN_SUPPLEMENT.md) -
 * the upstream StrategyContext feature-computation pipeline: RegimeEngine.ts, MarketContext.ts,
 * indicators/trend.ts, indicators/volatility.ts, indicators/priceAction.ts, indicators/volume.ts,
 * indicators/supportResistance.ts. Same pattern scripts/java_parity_fixtures_phase1.ts already
 * established for the 5 CORE strategies: synthetic-but-deterministic inputs (no Math.random, a
 * seeded LCG instead) are fed through the REAL production functions - not reimplementations - and
 * the full output is dumped as JSON so quant-core-java's JUnit parity tests can assert
 * byte-for-byte (epsilon-bounded) agreement against real TypeScript ground truth.
 *
 * DB safety note: MarketContext.ts's import chain pulls in HistoricalDataGateway.ts, which opens
 * the SQLite DB (and runs migrations) at module-import time via `import { db } from '../../db'`.
 * This script never calls that default path (getMarketContext's `fetchBars` parameter is injected
 * with a synthetic in-memory function below, exactly like MarketContext.test.ts's own
 * `fakeFetcher`), but the import itself still executes at load time regardless of whether the
 * default is used. Run this script with ARGUS_DB_PATH pointed at a scratch file (see the
 * accompanying run command in the migration report) - the same isolation mechanism
 * src/server/db/index.ts documents for e2e tests - so nothing here ever opens data/argus.db.
 *
 * Usage (from repo root):
 *   ARGUS_DB_PATH=<scratch path> npx tsx scripts/java_parity_fixtures_phase2.ts <output.json>
 *
 * Output is written directly to the given file path (fs.writeFileSync), not via console.log/
 * stdout - db/index.ts's own startup logging ("Running migrations...", seedModels' "Seeded
 * model: ...") writes to console.log too, which would otherwise interleave with and corrupt a
 * stdout-piped JSON payload.
 * ==========================================================
 */
import fs from 'fs';
import { Bar } from '../src/server/engines/backtest/HistoricalDataGateway';
import { computeTrendFeatures } from '../src/server/quant/indicators/trend';
import { computeVolatilityFeatures } from '../src/server/quant/indicators/volatility';
import { computePriceActionFeatures, detectGap, rangeExpansionContraction, detectConsolidation, detectCandlestickPattern } from '../src/server/quant/indicators/priceAction';
import { computeVolumeFeatures } from '../src/server/quant/indicators/volume';
import { computeSupportResistanceFeatures, premarketHighLow } from '../src/server/quant/indicators/supportResistance';
import { classifyRegime } from '../src/server/quant/RegimeEngine';
import { getMarketContext, BarsFetcher } from '../src/server/quant/MarketContext';

// ---------- Deterministic synthetic bar generation (no Math.random - reproducible across runs) ----------

/** Simple LCG (Numerical Recipes constants) - deterministic, seeded, reviewable. Not cryptographic;
 *  not meant to be - only used to shape realistic-looking noise for these fixtures. */
function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

interface SeriesOpts {
  start: number;
  driftPctPerBar: number;
  noiseAmpPct: number;
  volBase: number;
  seed: number;
  gapAtIndex?: number;
  gapPct?: number;
}

/** One bar per UTC calendar day (epoch-anchored, 86,400,000ms apart - same convention
 *  MarketContext.test.ts's own makeTrendingBars uses), open chained from the previous close so the
 *  series is continuous except where `gapAtIndex`/`gapPct` deliberately breaks that. */
function makeDailySeries(n: number, opts: SeriesOpts): Bar[] {
  const rand = seededRandom(opts.seed);
  const bars: Bar[] = [];
  let price = opts.start;
  for (let i = 0; i < n; i++) {
    let open = price;
    if (opts.gapAtIndex !== undefined && i === opts.gapAtIndex) {
      open = price * (1 + (opts.gapPct ?? 0) / 100);
    }
    const noise = (rand() - 0.5) * 2 * (opts.noiseAmpPct / 100) * open;
    const close = open * (1 + opts.driftPctPerBar / 100) + noise;
    const wick = Math.abs(noise) * 0.5 + open * 0.001;
    const high = round4(Math.max(open, close) + wick);
    const low = round4(Math.min(open, close) - wick);
    const volume = Math.round(opts.volBase * (0.6 + rand() * 0.8));
    bars.push({ timestamp: i * 86_400_000, open: round4(open), high, low, close: round4(close), volume });
    price = close;
  }
  return bars;
}

/** Appends a hand-constructed "gap up, then reverse and close bearish, on a volume spike" final
 *  bar pair - deliberately engineered (not derived from the noise generator) so the exact real
 *  TS predicates in priceAction.ts/volume.ts (detectGap's >0.5% threshold, detectCandlestickPattern's
 *  BEARISH_ENGULFING body/wick ratios, isVolumeSpike's RVOL>=2 default threshold) are all exercised
 *  by the SAME final bar - a real "gap and crap" pattern, not three separate contrived fixtures. */
function appendGapReversalEvent(bars: Bar[], startIndex: number, avgVolume: number): Bar[] {
  const out = bars.slice();
  const lastClose = out[out.length - 1].close;
  const prevOpen = lastClose;
  const prevClose = round4(prevOpen * 1.012);
  const prevHigh = round4(prevClose + 0.3);
  const prevLow = round4(prevOpen - 0.2);
  out.push({ timestamp: startIndex * 86_400_000, open: prevOpen, high: prevHigh, low: prevLow, close: prevClose, volume: Math.round(avgVolume) });

  const curOpen = round4(prevClose * 1.032); // 3.2% gap up vs prior close - real GAP_UP (>0.5% threshold)
  const curClose = round4(prevOpen - 0.1); // closes back down through prevOpen - bearish engulfing
  const curHigh = round4(curOpen + 0.15);
  const curLow = round4(curClose - 0.15);
  out.push({ timestamp: (startIndex + 1) * 86_400_000, open: curOpen, high: curHigh, low: curLow, close: curClose, volume: Math.round(avgVolume * 9) });
  return out;
}

// ---------- Fixture bar sets ----------

const insufficientData = makeDailySeries(10, { start: 100, driftPctPerBar: 0.2, noiseAmpPct: 1.0, volBase: 1_000_000, seed: 1 });

const uptrend120 = makeDailySeries(120, { start: 80, driftPctPerBar: 0.35, noiseAmpPct: 1.1, volBase: 1_500_000, seed: 2 });

const downtrend120 = makeDailySeries(120, { start: 200, driftPctPerBar: -0.35, noiseAmpPct: 1.1, volBase: 1_500_000, seed: 3 });

const rangingChoppy80 = makeDailySeries(80, { start: 50, driftPctPerBar: 0, noiseAmpPct: 0.9, volBase: 800_000, seed: 4 });

let longRich280 = makeDailySeries(278, { start: 150, driftPctPerBar: 0.15, noiseAmpPct: 1.2, volBase: 2_000_000, seed: 5, gapAtIndex: 150, gapPct: -2.4 });
longRich280 = appendGapReversalEvent(longRich280, 278, 2_000_000);

/** Intraday (5-minute) bars within one UTC calendar day - exercises the `openingRange`/
 *  premarket-availability branch (`looksDailyGranularity` must read false here), distinct from
 *  every other fixture above which is deliberately daily-granularity (realistic default for
 *  Argus's real ohlcv_bars per RegimeEngine/MarketContext's own header comments). */
function makeIntradaySeries(n: number, startTs: number, opts: Omit<SeriesOpts, 'start'> & { start: number }): Bar[] {
  const rand = seededRandom(opts.seed);
  const bars: Bar[] = [];
  let price = opts.start;
  for (let i = 0; i < n; i++) {
    const open = price;
    const noise = (rand() - 0.5) * 2 * (opts.noiseAmpPct / 100) * open;
    const close = open * (1 + opts.driftPctPerBar / 100) + noise;
    const wick = Math.abs(noise) * 0.5 + open * 0.0005;
    const high = round4(Math.max(open, close) + wick);
    const low = round4(Math.min(open, close) - wick);
    const volume = Math.round(opts.volBase * (0.6 + rand() * 0.8));
    bars.push({ timestamp: startTs + i * 5 * 60_000, open: round4(open), high, low, close: round4(close), volume });
    price = close;
  }
  return bars;
}

const intradaySessionStart = Date.UTC(2024, 5, 3, 13, 30); // arbitrary fixed real timestamp
const intradayOpeningRange = makeIntradaySeries(50, intradaySessionStart, { start: 300, driftPctPerBar: 0.02, noiseAmpPct: 0.3, volBase: 50_000, seed: 6 });

// ---------- Run the REAL production functions over each fixture ----------

function runBarFunctions(bars: Bar[]) {
  return {
    trend: computeTrendFeatures(bars),
    volatility: computeVolatilityFeatures(bars),
    priceAction: computePriceActionFeatures(bars),
    volume: computeVolumeFeatures(bars),
    supportResistance: computeSupportResistanceFeatures(bars),
    regime: (() => {
      const r = classifyRegime(bars);
      // deskSession is wall-clock (`new Date()`) dependent, not a deterministic function of the
      // supplied bars - explicitly excluded from the parity contract (JMIG-001's own OUTPUT
      // CONTRACT is the StrategyContext bundle, which does not include deskSession either).
      const { deskSession, ...rest } = r;
      return rest;
    })(),
  };
}

const fixtures: Record<string, any> = {
  insufficientData: { bars: insufficientData, ...runBarFunctions(insufficientData) },
  uptrend120: { bars: uptrend120, ...runBarFunctions(uptrend120) },
  downtrend120: { bars: downtrend120, ...runBarFunctions(downtrend120) },
  rangingChoppy80: { bars: rangingChoppy80, ...runBarFunctions(rangingChoppy80) },
  longRich280: { bars: longRich280, ...runBarFunctions(longRich280) },
  intradayOpeningRange: { bars: intradayOpeningRange, ...runBarFunctions(intradayOpeningRange) },
};

// Standalone premarketHighLow coverage (not part of computeSupportResistanceFeatures's own
// aggregate output, but a real exported function of supportResistance.ts - ported for full
// function-level parity per JMIG-001's file scope, not just the aggregate).
const premarketWindowMs = intradaySessionStart + 30 * 60_000; // first 30 minutes count as "premarket" for this fixture only
fixtures.intradayOpeningRange.premarketHighLow = premarketHighLow(intradayOpeningRange, premarketWindowMs);
fixtures.uptrend120.premarketHighLow = premarketHighLow(uptrend120, uptrend120[30].timestamp); // daily bars -> honestly unavailable

// ---------- MarketContext (pure-core) fixtures - synthetic injected BarsFetcher, zero network/DB ----------

const spyBars = makeDailySeries(260, { start: 400, driftPctPerBar: 0.12, noiseAmpPct: 0.8, volBase: 50_000_000, seed: 10 });
const qqqBars = makeDailySeries(260, { start: 350, driftPctPerBar: 0.22, noiseAmpPct: 1.0, volBase: 30_000_000, seed: 11 });
const iwmBars = makeDailySeries(260, { start: 200, driftPctPerBar: 0.0, noiseAmpPct: 0.5, volBase: 10_000_000, seed: 12 });
const xlkBars = makeDailySeries(260, { start: 180, driftPctPerBar: 0.18, noiseAmpPct: 0.9, volBase: 8_000_000, seed: 13 });
const aaplBars = makeDailySeries(260, { start: 150, driftPctPerBar: 0.28, noiseAmpPct: 1.1, volBase: 20_000_000, seed: 14 });

const marketContextFetcher: BarsFetcher = async (symbol) => {
  if (symbol === 'SPY') return spyBars;
  if (symbol === 'QQQ') return qqqBars;
  if (symbol === 'IWM') return iwmBars;
  if (symbol === 'XLK') return xlkBars;
  return [];
};

const failingFetcher: BarsFetcher = async (symbol) => {
  if (symbol === 'SPY') throw new Error('simulated Alpaca outage');
  if (symbol === 'QQQ') return qqqBars;
  if (symbol === 'IWM') return iwmBars;
  return [];
};

async function buildMarketContextFixtures() {
  const timeframe = '1Day';
  const startMs = 0;
  const endMs = 260 * 86_400_000;

  const aaplVsBenchmarks = await getMarketContext('AAPL', aaplBars, timeframe, startMs, endMs, marketContextFetcher);
  const unknownSector = await getMarketContext('ZZZZ_UNMAPPED', aaplBars, timeframe, startMs, endMs, marketContextFetcher);
  const fetchFailure = await getMarketContext('AAPL', aaplBars, timeframe, startMs, endMs, failingFetcher);

  return {
    aaplVsBenchmarks: {
      symbol: 'AAPL', symbolBars: aaplBars,
      benchmarkBars: { SPY: spyBars, QQQ: qqqBars, IWM: iwmBars, XLK: xlkBars },
      result: aaplVsBenchmarks,
    },
    unknownSector: {
      symbol: 'ZZZZ_UNMAPPED', symbolBars: aaplBars,
      benchmarkBars: { SPY: spyBars, QQQ: qqqBars, IWM: iwmBars },
      result: unknownSector,
    },
    fetchFailure: {
      symbol: 'AAPL', symbolBars: aaplBars,
      benchmarkBars: { QQQ: qqqBars, IWM: iwmBars },
      result: fetchFailure,
    },
  };
}

async function main() {
  const marketContext = await buildMarketContextFixtures();
  const outPath = process.argv[2];
  if (!outPath) {
    console.error('Usage: tsx scripts/java_parity_fixtures_phase2.ts <output.json>');
    process.exit(1);
  }
  fs.writeFileSync(outPath, JSON.stringify({ fixtures, marketContext }, null, 2));
  console.error(`Wrote fixtures to ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
