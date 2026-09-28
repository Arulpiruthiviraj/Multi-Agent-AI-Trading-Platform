/**
 * Real, standalone BTC/ETH research backtest against the REAL Java crypto strategies
 * (BtcAdaptiveVolatilityMomentumStrategy, BtcAdaptiveBollingerMeanReversionStrategy -
 * quant-core-java/.../institutional/models/), called causally bar-by-bar via the reviewed
 * QuantCoreBridge integration boundary. See src/server/research/btcEthBacktestHarness.ts for the
 * causal loop / fill / metrics logic this script only orchestrates.
 *
 * Research-only. Cannot place orders. Does not touch ChiefTrader, RiskEngine, PositionSizing, OMS,
 * or BrokerManager. Does not enable LIVE. Never fabricates a bar to fill a real historical gap.
 *
 * Prerequisites:
 *   1. The Java Quant Core process must be running and reachable at tradingSafety.quantJavaCoreBaseUrl
 *      (default http://127.0.0.1:8085): `java -jar quant-core-java/target/quant-core-java-*.jar`
 *   2. Real BTC/ETH daily bars must already exist in ohlcv_bars (symbol 'BTC'/'ETH', timeframe '1Day').
 *
 * Usage: npx tsx scripts/run_btc_eth_backtest.ts
 *
 * Writes real rows to `quant_strategy_backtests` (same table/shape the equity canonical research
 * path already writes to) - run as a standalone process against data/argus.db, same safe
 * invocation pattern as scripts/run_canonical_research.ts (not through the running engine's HTTP API).
 */
import dotenv from 'dotenv';
dotenv.config();

// Must be set before any tradingSafety-gated call - isQuantJavaCoreEnabled() reads this env var
// live on every call, so setting it here (rather than requiring the operator's own .env) keeps
// this script self-contained. This does NOT enable anything on the live engine - it only lets this
// standalone process's own QuantCoreBridge instance make read-only research HTTP calls.
process.env.QUANT_JAVA_CORE_ENABLED = process.env.QUANT_JAVA_CORE_ENABLED || 'true';

import { randomUUID } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '../src/server/db/index';
import { ohlcvBars, quantStrategyBacktests } from '../src/server/db/schema';
import { quantCoreBridge } from '../src/server/services/QuantCoreBridge';
import { getCryptoPaperExecutionAssumptions } from '../src/server/config/cryptoInstruments';
import { researchSafety } from '../src/server/config/researchSafety';
import {
  runCausalCryptoStrategy,
  applyCryptoNextBarFills,
  summarizeCryptoBacktest,
  type CryptoFillCosts,
} from '../src/server/research/btcEthBacktestHarness';
import type { ResearchBar } from '../src/server/research/ohlcvTypes';

/** Real, existing daily-bar symbols in this database (confirmed 2026-09-27: not 'BTC-USD'/'ETH-USD' -
 *  the ingested rows use the bare base-asset symbol). Timeframe '1Day' is queried explicitly and
 *  exclusively - this table stores a SEPARATE '1Min' timeframe for the same symbols (a live-tick
 *  tail from recent sessions), so no resampling/mixing decision is needed: filtering by
 *  timeframe='1Day' already isolates the clean, gappy-but-real daily series from the tick tail. */
const SYMBOLS = ['BTC', 'ETH'] as const;
const TIMEFRAME = '1Day';

interface StrategySpec {
  strategyId: string; // matches the Java class's own strategyId() / QuantCoreServer.java dispatcher key
  javaEndpointId: string;
  minBars: number; // matches the Java class's own evaluate()'s minBars requirement for default params
}

// Default-parameter minBars, matching BtcAdaptiveVolatilityMomentumStrategy/
// BtcAdaptiveBollingerMeanReversionStrategy's own `minBars` formulas at their documented defaults
// (momentumWindowDays=30, volatilityWindowDays=60 -> minBars=62; window=20 -> minBars=22).
const STRATEGIES: StrategySpec[] = [
  { strategyId: 'BTC_ADAPTIVE_VOLATILITY_MOMENTUM', javaEndpointId: 'btc_adaptive_volatility_momentum', minBars: 62 },
  { strategyId: 'BTC_ADAPTIVE_BOLLINGER_MEAN_REVERSION', javaEndpointId: 'btc_adaptive_bollinger_mean_reversion', minBars: 22 },
];

/** Fixed research-only position size for hypothetical fills. Never used by, or derived from,
 *  PositionSizing.ts - this is backtest bookkeeping only, not a live sizing decision. */
const BACKTEST_NOTIONAL_PER_TRADE_USD = 1000;

function loadBars(symbol: string): ResearchBar[] {
  const rows = db
    .select()
    .from(ohlcvBars)
    .where(and(eq(ohlcvBars.symbol, symbol), eq(ohlcvBars.timeframe, TIMEFRAME)))
    .all();
  return rows
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((r) => ({ timestamp: r.timestamp, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
}

async function runOne(spec: StrategySpec, symbol: string, bars: ResearchBar[]) {
  const nowIso = new Date().toISOString();
  const id = randomUUID();

  if (bars.length < spec.minBars) {
    const row = {
      id,
      strategyId: spec.strategyId,
      symbol,
      timeframe: TIMEFRAME,
      startDate: bars[0] ? new Date(bars[0].timestamp).toISOString() : nowIso,
      endDate: bars[bars.length - 1] ? new Date(bars[bars.length - 1].timestamp).toISOString() : nowIso,
      status: 'FAILED',
      errorMessage: `INSUFFICIENT_DATA: ${bars.length} real ${TIMEFRAME} bars available, strategy requires >= ${spec.minBars}`,
      createdAt: nowIso,
    };
    db.insert(quantStrategyBacktests).values(row).run();
    return { ...row, tradeCount: 0, insufficient: true as const };
  }

  const { signals, evaluatedBars, nullResponseCount, bridgeDegraded } = await runCausalCryptoStrategy({
    strategyId: spec.javaEndpointId,
    symbol,
    bars,
    minBars: spec.minBars,
    fetchStrategy: (strategyId, sym, slice) => quantCoreBridge.fetchResearchStrategy(strategyId, sym, slice),
  });

  if (bridgeDegraded) {
    // The Java Quant Core process is a real, shared, finite-capacity dependency (also used by the
    // live production engine's advisory features) - a majority-null response ratio means this run
    // reflects bridge unavailability/degradation, not genuine strategy behavior. Persisting a
    // "COMPLETED, 0 trades" row here would misrepresent an infrastructure failure as a real
    // backtest finding. Fail closed and say so honestly instead.
    const row = {
      id,
      strategyId: spec.strategyId,
      symbol,
      timeframe: TIMEFRAME,
      startDate: new Date(bars[0].timestamp).toISOString(),
      endDate: new Date(bars[bars.length - 1].timestamp).toISOString(),
      status: 'FAILED',
      errorMessage: `JAVA_QUANT_CORE_BRIDGE_DEGRADED: ${nullResponseCount}/${evaluatedBars} causal evaluations returned null (timeout/circuit-open/unreachable). This is an infrastructure outage, not a real strategy signal - do not treat as evidence the strategy never triggers.`,
      createdAt: nowIso,
    };
    db.insert(quantStrategyBacktests).values(row).run();
    return { ...row, tradeCount: 0, insufficient: true as const };
  }

  const paperAssumptions = getCryptoPaperExecutionAssumptions();
  const costs: CryptoFillCosts = {
    spreadBps: paperAssumptions.spreadBps,
    slippageBps: paperAssumptions.slippageBps,
    feeBps: paperAssumptions.feeBps,
    notionalPerTradeUsd: BACKTEST_NOTIONAL_PER_TRADE_USD,
  };
  const { trades, unclosedCount } = applyCryptoNextBarFills(bars, signals, costs);
  const metrics = summarizeCryptoBacktest(trades, researchSafety.minOosTrades);

  const insufficientTrades = metrics.tradeCount < researchSafety.minOosTrades;
  const row = {
    id,
    strategyId: spec.strategyId,
    symbol,
    timeframe: TIMEFRAME,
    startDate: new Date(bars[0].timestamp).toISOString(),
    endDate: new Date(bars[bars.length - 1].timestamp).toISOString(),
    status: 'COMPLETED',
    errorMessage: insufficientTrades
      ? `INSUFFICIENT_TRADES_FOR_VALIDATION: ${metrics.tradeCount} closed trades, researchSafety.minOosTrades requires ${researchSafety.minOosTrades}. Result is real, not fabricated positive evidence.`
      : null,
    initialCash: null,
    finalEquity: null,
    totalTrades: metrics.tradeCount,
    winRatePct: metrics.winRate !== null ? metrics.winRate * 100 : null,
    profitFactor: metrics.profitFactor,
    sharpe: metrics.sharpe.value,
    sortino: null,
    maxDrawdownPct: metrics.maxDrawdown !== null ? (metrics.maxDrawdown / BACKTEST_NOTIONAL_PER_TRADE_USD) * 100 : null,
    expectancy: metrics.expectancy,
    avgWinR: null,
    avgLossR: null,
    avgR: null,
    maxConsecutiveLosses: null,
    regimeBreakdown: null,
    expectedValue: null,
    kelly: null,
    tradeLog: JSON.stringify({
      trades,
      causal: true,
      executionModel: 'NEXT_BAR_OPEN',
      dataProvenance: 'REAL_MARKET_DATA',
      barsUsed: bars.length,
      evaluatedBars,
      nullResponseCount,
      unclosedCount,
      costModel: 'CONFIG',
      costQuality: 'ESTIMATED', // reused config/cryptoInstruments.json paperExecution assumptions - no organic crypto fills exist yet to MEASURE from
      costAssumptions: costs,
    }),
    equityCurve: null,
    benchmarkComparison: null,
    createdAt: nowIso,
  };
  db.insert(quantStrategyBacktests).values(row).run();
  return { ...row, tradeCount: metrics.tradeCount, insufficient: insufficientTrades };
}

async function main() {
  const report: Record<string, unknown>[] = [];

  for (const symbol of SYMBOLS) {
    const bars = loadBars(symbol);
    for (const spec of STRATEGIES) {
      const result = await runOne(spec, symbol, bars);
      report.push({
        symbol,
        strategyId: spec.strategyId,
        barsAvailable: bars.length,
        minBarsRequired: spec.minBars,
        status: result.status,
        totalTrades: 'totalTrades' in result ? result.totalTrades : 0,
        tradeCount: result.tradeCount,
        insufficient: result.insufficient,
        errorMessage: result.errorMessage,
        winRatePct: 'winRatePct' in result ? result.winRatePct : null,
        expectancy: 'expectancy' in result ? result.expectancy : null,
        profitFactor: 'profitFactor' in result ? result.profitFactor : null,
        sharpe: 'sharpe' in result ? result.sharpe : null,
        maxDrawdownPct: 'maxDrawdownPct' in result ? result.maxDrawdownPct : null,
        backtestId: result.id,
      });
    }
  }

  console.log(JSON.stringify({
    ok: true,
    canPlaceOrders: false,
    live: 'NO-GO',
    note: 'RESEARCH ONLY. Real historical bars, real Java strategies, causal per-bar evaluation, NEXT_BAR_OPEN fills. Never wired into the live pipeline. Does not promote any strategy lifecycle status.',
    results: report,
  }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
