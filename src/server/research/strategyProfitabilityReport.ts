/**
 * Phase 13 (2026-08-31 real-edge audit), item 3: real net-P&L trading-profitability report, per
 * strategy - closing the gap the audit found in the existing grading pipeline
 * (PredictionOutcomeEvaluator.ts), which only ever measures raw directional correctness
 * ((finalPrice - entryPrice) / entryPrice from signal time), never realized fill-to-fill P&L.
 * A strategy can be "right" on direction more than half the time and still lose money once real
 * entry/exit fills are used instead - this report answers that question directly using
 * getRealClosedRoundTrips() (LiveStrategyPerformance.ts), which already sources real,
 * organic-or-untagged FILLED BUY/SELL fill prices - it never estimates, backtests, or fabricates a
 * P&L number. Never touches consensus/RiskEngine/OMS/thresholds - read-only reporting.
 *
 * "Predictive edge" (direction-correctness win rate) and "trading profitability" (this report) are
 * deliberately kept separate outputs - see the audit's own explicit warning against conflating them.
 */
import { getRealClosedRoundTrips } from '../quant/risk/LiveStrategyPerformance';
import { wilsonInterval } from './effectiveSampleSize';

export interface StrategyProfitabilityRow {
  strategyId: string;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  winRate: number | null;
  wilsonLower: number | null;
  netPnl: number;
  grossWin: number;
  grossLoss: number;
  avgWin: number | null;
  avgLoss: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  maxDrawdown: number;
  maxDrawdownPct: number | null;
  /** Predictive-edge-vs-profitability divergence flag: >50% win rate but net-negative P&L, or the
   *  reverse - either case means win rate alone would have misled a promotion decision. */
  status: 'INSUFFICIENT_DATA' | 'NET_NEGATIVE' | 'NET_POSITIVE_LOW_CONFIDENCE' | 'NET_POSITIVE';
}

const MIN_TRADES_FOR_CONFIDENCE = 20;

export async function buildStrategyProfitabilityReport(): Promise<StrategyProfitabilityRow[]> {
  const roundTrips = await getRealClosedRoundTrips();
  const byStrategy = new Map<string, typeof roundTrips>();
  for (const rt of roundTrips) {
    if (!byStrategy.has(rt.strategyId)) byStrategy.set(rt.strategyId, []);
    byStrategy.get(rt.strategyId)!.push(rt);
  }

  const rows: StrategyProfitabilityRow[] = [];
  for (const [strategyId, trades] of byStrategy.entries()) {
    const sorted = [...trades].sort((a, b) => new Date(a.filledAt).getTime() - new Date(b.filledAt).getTime());
    const wins = sorted.filter((t) => t.profitLoss > 0);
    const losses = sorted.filter((t) => t.profitLoss <= 0);
    const netPnl = sorted.reduce((s, t) => s + t.profitLoss, 0);
    const grossWin = wins.reduce((s, t) => s + t.profitLoss, 0);
    const grossLoss = losses.reduce((s, t) => s + t.profitLoss, 0); // already <= 0

    let peak = 0;
    let cumulative = 0;
    let maxDrawdown = 0;
    for (const t of sorted) {
      cumulative += t.profitLoss;
      if (cumulative > peak) peak = cumulative;
      const drawdown = peak - cumulative;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    const w = wilsonInterval(wins.length, sorted.length);
    const winRate = sorted.length > 0 ? wins.length / sorted.length : null;
    const avgWin = wins.length > 0 ? grossWin / wins.length : null;
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : null;
    const profitFactor = grossLoss < 0 ? grossWin / Math.abs(grossLoss) : (grossWin > 0 ? null : null);
    const expectancy = sorted.length > 0 ? netPnl / sorted.length : null;

    let status: StrategyProfitabilityRow['status'];
    if (sorted.length < 5) status = 'INSUFFICIENT_DATA';
    else if (netPnl <= 0) status = 'NET_NEGATIVE';
    else if (sorted.length < MIN_TRADES_FOR_CONFIDENCE) status = 'NET_POSITIVE_LOW_CONFIDENCE';
    else status = 'NET_POSITIVE';

    rows.push({
      strategyId,
      tradeCount: sorted.length,
      winCount: wins.length,
      lossCount: losses.length,
      winRate,
      wilsonLower: w.lower,
      netPnl,
      grossWin,
      grossLoss,
      avgWin,
      avgLoss,
      profitFactor,
      expectancy,
      maxDrawdown,
      maxDrawdownPct: peak > 0 ? maxDrawdown / peak : null,
      status,
    });
  }

  return rows.sort((a, b) => b.tradeCount - a.tradeCount);
}

export function formatStrategyProfitabilityReport(rows: StrategyProfitabilityRow[]): string {
  const idWidth = Math.max(24, ...rows.map((r) => r.strategyId.length + 2), 1);
  const lines = [
    'STRATEGY PROFITABILITY (REAL closed round-trips - real fill prices, real dollar P&L, never estimated)',
    '-----------------------------------------------------------------------------------------------------',
    'This measures whether trading a strategy would have made money, NOT whether its direction call was right.',
    '',
    'Strategy'.padEnd(idWidth) + 'Trades'.padEnd(8) + 'WinRate'.padEnd(9) + 'WilsonLo'.padEnd(10)
      + 'NetPnL'.padEnd(11) + 'PF'.padEnd(8) + 'Expectancy'.padEnd(12) + 'MaxDD'.padEnd(10) + 'Status',
  ];
  if (rows.length === 0) {
    lines.push('(no real organic closed round-trips exist yet for any strategy)');
    return lines.join('\n');
  }
  for (const r of rows) {
    lines.push(
      r.strategyId.padEnd(idWidth)
      + String(r.tradeCount).padEnd(8)
      + (r.winRate !== null ? `${(r.winRate * 100).toFixed(1)}%` : 'N/A').padEnd(9)
      + (r.wilsonLower !== null ? r.wilsonLower.toFixed(3) : 'N/A').padEnd(10)
      + `$${r.netPnl.toFixed(2)}`.padEnd(11)
      + (r.profitFactor !== null ? r.profitFactor.toFixed(2) : 'N/A').padEnd(8)
      + (r.expectancy !== null ? `$${r.expectancy.toFixed(2)}` : 'N/A').padEnd(12)
      + `$${r.maxDrawdown.toFixed(2)}`.padEnd(10)
      + r.status,
    );
  }
  return lines.join('\n');
}
