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

export interface WalkForwardConfig {
  symbols: string[];
  startDate: string;
  endDate: string;
  timeframe?: string;
  initialCash?: number;
  trainDays: number;
  testDays: number; // the out-of-sample window scored for each period
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

    const periods: WalkForwardPeriodResult[] = [];
    let windowStart = startMs;
    let periodIdx = 0;

    while (windowStart + trainMs + testMs <= endMs) {
      const trainStart = windowStart;
      const trainEnd = windowStart + trainMs;
      const testStart = trainEnd;
      const testEnd = trainEnd + testMs;

      // train() and test() run the identical, fixed strategy rules - "training" here means
      // observing in-sample performance, not fitting any parameter. BacktestEngine has no
      // tunable parameters that this validator adjusts based on train results; the point is to
      // make in-sample-vs-out-of-sample divergence visible, not to eliminate it by overfitting.
      const train = await backtestEngine.run({
        symbols: config.symbols,
        startDate: new Date(trainStart).toISOString(),
        endDate: new Date(trainEnd).toISOString(),
        timeframe: config.timeframe,
        initialCash: config.initialCash,
      });
      const test = await backtestEngine.run({
        symbols: config.symbols,
        startDate: new Date(testStart).toISOString(),
        endDate: new Date(testEnd).toISOString(),
        timeframe: config.timeframe,
        initialCash: config.initialCash,
      });

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

    return {
      periods,
      periodCount: periods.length,
      avgInSampleReturnPct: Number(avgIS.toFixed(2)),
      avgOutOfSampleReturnPct: Number(avgOOS.toFixed(2)),
      outOfSamplePositivePeriodPct: Number(((oosPositivePeriods / periods.length) * 100).toFixed(1)),
      // A strategy that only works in-sample and falls apart out-of-sample is the textbook
      // overfitting signature this number is meant to surface, not hide.
      inSampleVsOutOfSampleGapPct: Number((avgIS - avgOOS).toFixed(2)),
      insufficientPeriods: periods.length < 5,
      note: periods.length < 5
        ? `Only ${periods.length} walk-forward period(s) - too few to draw a real conclusion about out-of-sample robustness. Widen the date range or shorten the windows.`
        : null,
    };
  }
}

export const walkForwardValidator = new WalkForwardValidator();
