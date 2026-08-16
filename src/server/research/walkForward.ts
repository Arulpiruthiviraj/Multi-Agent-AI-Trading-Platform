/**
 * Train/validate/test walk-forward on golden SMA. Optimize only TRAIN; score VALIDATION; freeze; evaluate TEST.
 */
import { researchSafety } from '../config/researchSafety';
import { runSmaCrossover, type SmaBacktestResult } from './smaCrossover';
import type { ResearchBar } from './ohlcvTypes';

export interface WalkForwardWindow {
  trainEnd: number;
  valEnd: number;
  testEnd: number;
  selectedFast: number;
  selectedSlow: number;
  trainNetPnl: number;
  valNetPnl: number;
  testNetPnl: number;
  testTradeCount: number;
}

export interface WalkForwardReport {
  windows: WalkForwardWindow[];
  aggregatedTestNetPnl: number;
  aggregatedTestTrades: number;
  oosOnly: true;
  optimizedOnTest: false;
}

function grid(): Array<{ fast: number; slow: number }> {
  const out: Array<{ fast: number; slow: number }> = [];
  for (const fast of [2, 3, 4]) {
    for (const slow of [6, 8, 10]) {
      if (fast < slow) out.push({ fast, slow });
    }
  }
  return out;
}

function sliceBars(bars: ResearchBar[], start: number, end: number): ResearchBar[] {
  return bars.slice(start, end);
}

export function runGoldenWalkForward(bars: ResearchBar[]): WalkForwardReport {
  const n = bars.length;
  const trainLen = Math.floor(n * 0.5);
  const valLen = Math.floor(n * 0.25);
  const testLen = n - trainLen - valLen;
  const windows: WalkForwardWindow[] = [];
  if (testLen < 4) {
    return { windows: [], aggregatedTestNetPnl: 0, aggregatedTestTrades: 0, oosOnly: true, optimizedOnTest: false };
  }

  const t0 = 0;
  const t1 = trainLen;
  const t2 = trainLen + valLen;
  const t3 = n;
  const capital = researchSafety.goldenInitialCapital;
  let best = { fast: researchSafety.goldenSmaFast, slow: researchSafety.goldenSmaSlow, val: -Infinity, train: 0 };
  for (const g of grid()) {
    const train = runSmaCrossover(sliceBars(bars, t0, t1), g.fast, g.slow, capital);
    const val = runSmaCrossover(sliceBars(bars, t1, t2), g.fast, g.slow, capital);
    if (val.netPnl > best.val) best = { fast: g.fast, slow: g.slow, val: val.netPnl, train: train.netPnl };
  }
  const test = runSmaCrossover(sliceBars(bars, t2, t3), best.fast, best.slow, capital);
  windows.push({
    trainEnd: t1,
    valEnd: t2,
    testEnd: t3,
    selectedFast: best.fast,
    selectedSlow: best.slow,
    trainNetPnl: best.train,
    valNetPnl: best.val,
    testNetPnl: test.netPnl,
    testTradeCount: test.tradeCount,
  });

  return {
    windows,
    aggregatedTestNetPnl: windows.reduce((a, w) => a + w.testNetPnl, 0),
    aggregatedTestTrades: windows.reduce((a, w) => a + w.testTradeCount, 0),
    oosOnly: true,
    optimizedOnTest: false,
  };
}

export function purgedEmbargoSplit(n: number, embargoBars: number): { trainEnd: number; testStart: number } {
  const trainEnd = Math.floor(n * 0.7);
  return { trainEnd, testStart: Math.min(n, trainEnd + Math.max(0, embargoBars)) };
}

export type { SmaBacktestResult };
