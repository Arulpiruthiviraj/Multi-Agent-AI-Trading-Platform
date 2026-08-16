/**
 * ==========================================================
 * Module: WalkForwardValidator
 *
 * Purpose:
 * Splits a date range into rolling train/validation/test windows and runs
 * BacktestEngine on each, so a strategy's performance on unseen data can be
 * compared honestly against the window it (implicitly) tuned on. Never
 * optimizes any parameter on the test window - BacktestEngine's rules are
 * fixed, deterministic, and identical across every window.
 * ==========================================================
 */
import { backtestEngine } from './BacktestEngine';
import { evaluateWalkForwardHarness } from '../../quant/analysis/MonteCarlo';

export interface WalkForwardConfig {
  /** Required unless strategyId+symbol are given (see below) - the original run()-backed mode. */
  symbols?: string[];
  startDate: string;
  endDate: string;
  timeframe?: string;
  initialCash?: number;
  trainDays: number;
  // The out-of-sample window scored for each period. Must be wide enough that the underlying
  // backtest's own minimum-bar requirement can be satisfied WITHIN this window alone (daily bars:
  // BacktestEngine.run() LOOKBACK from tradingSafety.backtestLookbackBars, runStrategyBacktest()
  // REGIME_MIN_BARS from tradingSafety.regimeMinBars). A testDays narrower than that will make
  // every period's test call throw "Only N real bars available", regardless of how much data
  // exists outside the window, since each window is evaluated on its own bars only.
  testDays: number;
  /** E5 (BACKTEST_QUANT_HARDENING_ANALYSIS.md) - when both are set, each train/test window runs
   * BacktestEngine.runStrategyBacktest() (the quant-layer strategies) for this one symbol instead
   * of the original run()-backed path. Mutually exclusive with `symbols` - runStrategyBacktest()
   * is single-symbol by design, matching its existing scope (no short selling, one named
   * strategy). Still never optimizes anything on the test window - the strategy's own rules are
   * fixed and identical across every window, exactly like the original run()-backed mode. */
  strategyId?: string;
  symbol?: string;
}

export interface WalkForwardPeriodResult {
  period: number;
  trainStart: string;
  trainEnd: string;
  testStart: string;
  testEnd: string;
  train: any;
  test: any;
}

export class WalkForwardValidator {
  async run(config: WalkForwardConfig) {
    const startMs = new Date(config.startDate).getTime();
    const endMs = new Date(config.endDate).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
      throw new Error('startDate must be a valid date before endDate.');
    }
    const dayMs = 24 * 60 * 60 * 1000;
    const trainMs = config.trainDays * dayMs;
    const testMs = config.testDays * dayMs;
    if (trainMs <= 0 || testMs <= 0) throw new Error('trainDays and testDays must both be positive.');

    // E5 - exactly one of the two real backtest entry points, never both. Mirrors this codebase's
    // existing convention (run() for the original hardcoded strategy, runStrategyBacktest() for
    // the additive quant-layer strategies) rather than inventing a third path.
    const useQuantStrategy = !!(config.strategyId && config.symbol);
    if (!useQuantStrategy && (!config.symbols || config.symbols.length === 0)) {
      throw new Error('Either symbols (run()-backed mode) or both strategyId and symbol (runStrategyBacktest()-backed mode) must be provided.');
    }

    const periods: WalkForwardPeriodResult[] = [];
    let windowStart = startMs;
    let periodIdx = 0;

    while (windowStart + trainMs + testMs <= endMs) {
      const trainStart = windowStart;
      const trainEnd = windowStart + trainMs;
      const testStart = trainEnd;
      const testEnd = trainEnd + testMs;

      // train() and test() run the identical, fixed strategy rules - "training" here means
      // observing in-sample performance, not fitting any parameter. Neither real backtest entry
      // point has a tunable parameter this validator adjusts based on train results; the point is
      // to make in-sample-vs-out-of-sample divergence visible, not to eliminate it by overfitting.
      const runOneWindow = (windowStartMs: number, windowEndMs: number) => useQuantStrategy
        ? backtestEngine.runStrategyBacktest({
            strategyId: config.strategyId!, symbol: config.symbol!,
            startDate: new Date(windowStartMs).toISOString(), endDate: new Date(windowEndMs).toISOString(),
            timeframe: config.timeframe, initialCash: config.initialCash,
          })
        : backtestEngine.run({
            symbols: config.symbols!,
            startDate: new Date(windowStartMs).toISOString(), endDate: new Date(windowEndMs).toISOString(),
            timeframe: config.timeframe, initialCash: config.initialCash,
          });

      const train = await runOneWindow(trainStart, trainEnd);
      const test = await runOneWindow(testStart, testEnd);

      periods.push({
        period: periodIdx,
        trainStart: new Date(trainStart).toISOString(),
        trainEnd: new Date(trainEnd).toISOString(),
        testStart: new Date(testStart).toISOString(),
        testEnd: new Date(testEnd).toISOString(),
        train,
        test,
      });

      periodIdx++;
      windowStart += testMs; // roll forward by the test window (standard rolling walk-forward)
    }

    if (periods.length === 0) {
      throw new Error(`Date range too short for trainDays=${config.trainDays} + testDays=${config.testDays} - widen startDate/endDate or shorten the windows.`);
    }

    const outOfSampleReturns = periods.map(p => p.test.totalReturnPct);
    const inSampleReturns = periods.map(p => p.train.totalReturnPct);
    const avgOOS = outOfSampleReturns.reduce((a, b) => a + b, 0) / outOfSampleReturns.length;
    const avgIS = inSampleReturns.reduce((a, b) => a + b, 0) / inSampleReturns.length;
    const oosPositivePeriods = outOfSampleReturns.filter(r => r > 0).length;
    const avgSharpeIS = periods.reduce((a, p) => a + (Number(p.train.sharpe) || 0), 0) / periods.length;
    const avgSharpeOOS = periods.reduce((a, p) => a + (Number(p.test.sharpe) || 0), 0) / periods.length;
    const avgOosWinRatePct = periods.reduce((a, p) => a + (Number(p.test.winRatePct) || 0), 0) / periods.length;
    const harness = evaluateWalkForwardHarness({
      periodCount: periods.length,
      avgSharpeIS,
      avgSharpeOOS,
      avgOosWinRatePct,
    });

    return {
      periods,
      periodCount: periods.length,
      avgInSampleReturnPct: Number(avgIS.toFixed(2)),
      avgOutOfSampleReturnPct: Number(avgOOS.toFixed(2)),
      outOfSamplePositivePeriodPct: Number(((oosPositivePeriods / periods.length) * 100).toFixed(1)),
      inSampleVsOutOfSampleGapPct: Number((avgIS - avgOOS).toFixed(2)),
      avgInSampleSharpe: Number(avgSharpeIS.toFixed(4)),
      avgOutOfSampleSharpe: Number(avgSharpeOOS.toFixed(4)),
      avgOosWinRatePct: Number(avgOosWinRatePct.toFixed(1)),
      oosSharpeDegradation: harness.oosSharpeDegradation,
      oosWinRate: harness.oosWinRate,
      verdict: harness.verdict,
      insufficientPeriods: periods.length < 5,
      note: harness.reason,
    };
  }
}

export const walkForwardValidator = new WalkForwardValidator();
