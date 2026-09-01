/**
 * Phase 13 (2026-08-31 real-edge audit), item 3 + Phase 14 (2026-08-31 historical-replay & fair-
 * exploration mission), Objective 3: real net-P&L trading-profitability report, per strategy -
 * closing the gap the audit found in the existing grading pipeline
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
 *
 * Phase 14 addition: the primary numbers (netPnl, grossWin, grossLoss, etc.) remain OBSERVED -
 * real fill prices exactly as this paper broker recorded them, with whatever cost (if any) that
 * broker already reflects. This environment's paper broker does not charge a commission and its
 * fills do not carry a separately-recorded spread/slippage figure, so those specific cost
 * components are UNKNOWN from real data alone here - not zero, not estimated, genuinely unknown.
 * To make that gap visible rather than silently absent, each row ALSO reports a clearly-labeled
 * CONFIGURED SIMULATION ASSUMPTION: net P&L after applying one of replaySafety.json's existing,
 * already-reviewed cost profiles (commissionPerShare + spreadBps + slippageBps - the same profiles
 * the historical replay engine already uses, never a new invented cost model) on top of the real
 * fill prices/quantities. This is explicitly a simulation, never presented as observed.
 */
import { getRealClosedRoundTrips } from '../quant/risk/LiveStrategyPerformance';
import { wilsonInterval } from './effectiveSampleSize';
import { replaySafety, type ReplayCostProfile } from '../replay/replaySafety';

export interface StrategyProfitabilityRow {
  strategyId: string;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  winRate: number | null;
  wilsonLower: number | null;
  /** OBSERVED - real fill prices exactly as recorded, never simulated. */
  netPnl: number;
  grossWin: number;
  grossLoss: number;
  avgWin: number | null;
  avgLoss: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  maxDrawdown: number;
  maxDrawdownPct: number | null;
  /** CONFIGURED SIMULATION ASSUMPTION (not observed) - which replaySafety.json cost profile was
   *  applied on top of the real OBSERVED fills to estimate realistic commission/spread/slippage
   *  drag, since this paper broker's own fills do not carry a separately observed cost figure. */
  simulatedCostProfile: string;
  /** CONFIGURED SIMULATION ASSUMPTION - total estimated cost (positive number) the profile above
   *  would have added on top of the real fill prices/quantities. */
  simulatedTransactionCosts: number;
  /** CONFIGURED SIMULATION ASSUMPTION - netPnl minus simulatedTransactionCosts. Never the
   *  "observed" number - always label this as a simulation assumption when reporting it. */
  simulatedNetPnl: number;
  /** Predictive-edge-vs-profitability divergence flag: >50% win rate but net-negative P&L, or the
   *  reverse - either case means win rate alone would have misled a promotion decision. Based on
   *  OBSERVED netPnl, not the cost-simulated figure. */
  status: 'INSUFFICIENT_DATA' | 'NET_NEGATIVE' | 'NET_POSITIVE_LOW_CONFIDENCE' | 'NET_POSITIVE';
}

const MIN_TRADES_FOR_CONFIDENCE = 20;

/** Estimated round-trip cost (commission both legs + spread/slippage applied to both legs' notional)
 *  under a named replaySafety.json cost profile - a CONFIGURED SIMULATION ASSUMPTION, never an
 *  observed cost, applied identically to every strategy so relative comparisons stay fair. */
function estimateRoundTripCost(profile: ReplayCostProfile, entryPrice: number, exitPrice: number, quantity: number): number {
  const commission = profile.commissionPerShare * quantity * 2; // entry + exit legs
  const bpsCost = (profile.spreadBps + profile.slippageBps) / 10000;
  const notionalBothLegs = (entryPrice + exitPrice) * quantity;
  return commission + bpsCost * notionalBothLegs;
}

export async function buildStrategyProfitabilityReport(costProfileName?: string): Promise<StrategyProfitabilityRow[]> {
  const profileName = costProfileName ?? replaySafety.defaultCostProfile;
  const profile = replaySafety.costProfiles[profileName];
  if (!profile) {
    throw new Error(`Unknown cost profile "${profileName}" - must be one of: ${Object.keys(replaySafety.costProfiles).join(', ')}`);
  }
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

    const simulatedTransactionCosts = sorted.reduce(
      (s, t) => s + estimateRoundTripCost(profile, t.entryPrice, t.exitPrice, t.quantity), 0,
    );

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
      simulatedCostProfile: profileName,
      simulatedTransactionCosts,
      simulatedNetPnl: netPnl - simulatedTransactionCosts,
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
    'NetPnL/PF/Expectancy/MaxDD below are OBSERVED (real fills). SimCost/SimNetPnL are a CONFIGURED',
    `SIMULATION ASSUMPTION (cost profile: ${rows[0]?.simulatedCostProfile ?? 'n/a'}) layered on top of real fills -`,
    'this paper broker does not itself record a separate commission/spread/slippage figure, so that',
    'specific cost component is genuinely UNKNOWN from observed data alone, not zero.',
    '',
    'Strategy'.padEnd(idWidth) + 'Trades'.padEnd(8) + 'WinRate'.padEnd(9) + 'WilsonLo'.padEnd(10)
      + 'NetPnL'.padEnd(11) + 'PF'.padEnd(8) + 'Expectancy'.padEnd(12) + 'MaxDD'.padEnd(10)
      + 'SimCost'.padEnd(10) + 'SimNetPnL'.padEnd(12) + 'Status',
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
      + `$${r.simulatedTransactionCosts.toFixed(2)}`.padEnd(10)
      + `$${r.simulatedNetPnl.toFixed(2)}`.padEnd(12)
      + r.status,
    );
  }
  return lines.join('\n');
}
