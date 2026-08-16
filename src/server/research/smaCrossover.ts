/**
 * Timestamp-safe SMA crossover for the golden fixture.
 * Signal at bar i uses closes[0..i] only. Fill modeled at bar i+1 open (next-bar execution).
 */
import type { ResearchBar } from './ohlcvTypes';

export interface SmaTrade {
  entryBarIndex: number;
  exitBarIndex: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  entryTimestamp: number;
  exitTimestamp: number;
}

export interface SmaBacktestResult {
  engine: 'argus_sma';
  lookAheadModel: 'signal_at_T_execute_next_open';
  fast: number;
  slow: number;
  initialCapital: number;
  fees: number;
  netPnl: number;
  grossPnl: number;
  tradeCount: number;
  trades: SmaTrade[];
  entryTimestamps: number[];
  exitTimestamps: number[];
}

function smaAt(closes: number[], n: number, i: number): number | null {
  if (i < n - 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += closes[k];
  return s / n;
}

export function runSmaCrossover(
  bars: ResearchBar[],
  fast: number,
  slow: number,
  initialCapital: number,
  commissionPerShare = 0,
): SmaBacktestResult {
  const closes = bars.map((b) => b.close);
  const trades: SmaTrade[] = [];
  let long = false;
  let entryIdx = -1;
  let entryPrice = 0;
  let fees = 0;
  const qty = 1;

  for (let i = 0; i < bars.length; i++) {
    const f = smaAt(closes, fast, i);
    const s = smaAt(closes, slow, i);
    const fp = i > 0 ? smaAt(closes, fast, i - 1) : null;
    const sp = i > 0 ? smaAt(closes, slow, i - 1) : null;
    if (f == null || s == null || fp == null || sp == null) continue;
    const crossUp = fp <= sp && f > s;
    const crossDown = fp >= sp && f < s;
    const execIdx = i + 1;
    if (execIdx >= bars.length) continue;
    const px = bars[execIdx].open;
    if (crossUp && !long) {
      long = true;
      entryIdx = execIdx;
      entryPrice = px;
      fees += commissionPerShare * qty;
    } else if (crossDown && long) {
      const pnl = (px - entryPrice) * qty - commissionPerShare * qty;
      fees += commissionPerShare * qty;
      trades.push({
        entryBarIndex: entryIdx,
        exitBarIndex: execIdx,
        entryPrice,
        exitPrice: px,
        pnl,
        entryTimestamp: bars[entryIdx].timestamp,
        exitTimestamp: bars[execIdx].timestamp,
      });
      long = false;
      entryIdx = -1;
    }
  }

  const grossPnl = trades.reduce((a, t) => a + (t.exitPrice - t.entryPrice) * qty, 0);
  const netPnl = trades.reduce((a, t) => a + t.pnl, 0);
  return {
    engine: 'argus_sma',
    lookAheadModel: 'signal_at_T_execute_next_open',
    fast,
    slow,
    initialCapital,
    fees,
    netPnl,
    grossPnl,
    tradeCount: trades.length,
    trades,
    entryTimestamps: trades.map((t) => t.entryTimestamp),
    exitTimestamps: trades.map((t) => t.exitTimestamp),
  };
}

/** Mutating bar i+1 close must not change the signal computed at i. */
export function signalUsesOnlyClosesThrough(bars: ResearchBar[], fast: number, slow: number, i: number): boolean {
  const closes = bars.map((b) => b.close);
  const f = smaAt(closes, fast, i);
  const s = smaAt(closes, slow, i);
  if (i + 1 >= bars.length || f == null || s == null) return true;
  const clone = bars.map((b) => ({ ...b }));
  clone[i + 1] = { ...clone[i + 1], close: clone[i + 1].close * 10 };
  const closes2 = clone.map((b) => b.close);
  return smaAt(closes2, fast, i) === f && smaAt(closes2, slow, i) === s;
}
