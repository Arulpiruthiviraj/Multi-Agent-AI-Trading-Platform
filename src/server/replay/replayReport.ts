import { replaySafety } from './replaySafety';
import type { ReplayTradeRecord } from './ReplayContext';

export interface ReplayDecisionFunnel {
  evaluationsAttempted: number;
  strategyPassesAttempted: number;
  dataUnavailable: number;
  insufficientSample: number;
  analyzed: number;
  noValidIdea: number;
  ideasGenerated: number;
  consensusRejected: number;
  consensusApproved: number;
  ordersSubmitted: number;
  ordersFilled: number;
  ordersRejected: number;
  rejectionReasons: Record<string, number>;
  methodology: string;
}

/**
 * Built entirely from counters the engine already tracks (session.noTrade, tradeLedger,
 * rejectedOrders) - not new fabricated data. This is an evaluation-instance funnel (one count per
 * symbol-timestamp-strategy pass), not a unique-candidate funnel - stated explicitly in
 * `methodology` rather than implied, since a symbol evaluated on 60 different historical days
 * counts 60 times here, not once.
 *
 * Two counting levels coexist here on purpose: evaluationsAttempted/analyzed are symbol-timestamp
 * level (one increment per symbol per tick, before any strategy runs), but NO_VALID_STRATEGY is
 * bumped once per strategyId per symbol-tick inside FullArgusReplayEngine.ts's
 * `for (const strategyId of session.config.strategyIds)` loop. With a single strategyId those two
 * levels are numerically identical, but with ALL_CORE (multiple strategyIds) NO_VALID_STRATEGY can
 * legitimately exceed evaluationsAttempted - comparing it against evaluationsAttempted clamps
 * ideasGenerated to 0 and hides real ideas. strategyPassesAttempted is the real per-strategy-pass
 * denominator ideasGenerated is computed against instead.
 */
export function buildDecisionFunnel(opts: {
  evaluationsAttempted: number;
  strategyPassesAttempted?: number;
  noTrade: Record<string, number>;
  tradeLedger: ReplayTradeRecord[];
  rejectedOrders: Array<{ reason: string }>;
}): ReplayDecisionFunnel {
  const dataUnavailable = opts.noTrade.DATA_UNAVAILABLE || 0;
  const insufficientSample = opts.noTrade.INSUFFICIENT_SAMPLE || 0;
  const analyzed = Math.max(0, opts.evaluationsAttempted - dataUnavailable - insufficientSample);
  // Fallback to `analyzed` when the caller doesn't pass strategyPassesAttempted (older callers /
  // single-strategy assumption) - numerically identical to the old behavior in that case.
  const strategyPassesAttempted = opts.strategyPassesAttempted ?? analyzed;
  const noValidIdea = opts.noTrade.NO_VALID_STRATEGY || 0;
  const ideasGenerated = Math.max(0, strategyPassesAttempted - noValidIdea);
  const consensusRejected = opts.noTrade.NO_CHIEF_APPROVAL || 0;
  const consensusApproved = Math.max(0, ideasGenerated - consensusRejected);
  const ordersFilled = opts.tradeLedger.length;
  const ordersRejected = opts.rejectedOrders.length;
  const ordersSubmitted = ordersFilled + ordersRejected;
  const rejectionReasons: Record<string, number> = {};
  for (const r of opts.rejectedOrders) rejectionReasons[r.reason] = (rejectionReasons[r.reason] || 0) + 1;

  return {
    evaluationsAttempted: opts.evaluationsAttempted,
    strategyPassesAttempted,
    dataUnavailable,
    insufficientSample,
    analyzed,
    noValidIdea,
    ideasGenerated,
    consensusRejected,
    consensusApproved,
    ordersSubmitted,
    ordersFilled,
    ordersRejected,
    rejectionReasons,
    methodology: 'Evaluation-instance funnel: evaluationsAttempted/analyzed are symbol-timestamp level (one per symbol per tick); noValidIdea/ideasGenerated are symbol-timestamp-strategy level (one per strategyId per symbol per tick - matters for ALL_CORE multi-strategy runs, compared against strategyPassesAttempted, not evaluationsAttempted). Not per unique candidate - a symbol evaluated on 60 different historical days counts 60 times here, not once. consensusApproved/ordersSubmitted include both new-entry BUY evaluations and exit SELL submissions (stop/target/generic/ExitIntelligenceEngine), since both flow through the same RiskEngine/OMS path.',
  };
}

export interface ReplayAgentEvaluation {
  ideas: number;
  buyIdeas: number;
  sellIdeas: number;
  averageConfidence: number | null;
}

/** Built from session.agentIdeaStats, accumulated inline as ideas are generated - not a separate pass. */
export function buildAgentEvaluation(
  agentIdeaStats: Record<string, { ideas: number; buyIdeas: number; sellIdeas: number; confidenceSum: number }>,
): Record<string, ReplayAgentEvaluation> {
  const out: Record<string, ReplayAgentEvaluation> = {};
  for (const [agent, s] of Object.entries(agentIdeaStats)) {
    out[agent] = {
      ideas: s.ideas,
      buyIdeas: s.buyIdeas,
      sellIdeas: s.sellIdeas,
      averageConfidence: s.ideas > 0 ? Number((s.confidenceSum / s.ideas).toFixed(4)) : null,
    };
  }
  return out;
}

export interface MetricSample {
  status: 'INSUFFICIENT_SAMPLE' | 'OK' | 'NOT_COMPUTED' | 'UNAVAILABLE';
  value: number | null;
  sampleSize?: number;
  reason?: string;
}

export interface ReplayPerformanceReport {
  environment: 'HISTORICAL_REPLAY';
  notPaper: true;
  notLive: true;
  executionModel: 'NEXT_BAR_OPEN';
  costProfile: string;
  zeroCostWarning: string | null;
  startingCapital: number;
  endingCapital: number;
  netPnl: number;
  netReturnPct: number;
  grossPnl: number;
  totalFees: number;
  totalSlippage: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  sharpe: MetricSample;
  sortino: MetricSample;
  profitFactor: number | null;
  winRate: number | null;
  lossRate: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  expectancy: number | null;
  totalTrades: number;
  buyTrades: number;
  sellTrades: number;
  shortTrades: 0;
  coverTrades: 0;
  exposure: MetricSample;
  turnover: MetricSample;
  perSymbol: Record<string, { trades: number; realizedPnl: number; buyNotional: number; sellNotional: number }>;
  perStrategy: Record<string, { trades: number; realizedPnl: number }>;
  benchmark: {
    status: 'UNAVAILABLE' | 'OK';
    symbols: string[];
    note: string;
    buyAndHoldReturnPct: number | null;
  };
  noTrade: Record<string, number>;
  honesty: string[];
}

function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

export function buildReplayPerformance(opts: {
  startingCapital: number;
  endingCapital: number;
  grossPnl: number;
  fees: number;
  slippage: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  tradePnls: number[];
  buyTrades: number;
  sellTrades: number;
  noTrade: Record<string, number>;
  costProfile: string;
  equityCurve: Array<{ t: number; equity: number; cash: number }>;
  trades: ReplayTradeRecord[];
  benchmarkBars?: Array<{ timestamp: number; close: number }> | null;
}): ReplayPerformanceReport {
  const n = opts.tradePnls.length;
  const net = opts.endingCapital - opts.startingCapital;
  const wins = opts.tradePnls.filter((p) => p > 0);
  const losses = opts.tradePnls.filter((p) => p < 0);
  const avg = mean(opts.tradePnls);

  let sharpe: MetricSample = { status: 'INSUFFICIENT_SAMPLE', value: null, sampleSize: n };
  if (n >= replaySafety.minSharpeTrades && avg != null) {
    const variance = opts.tradePnls.reduce((s, v) => s + (v - avg) ** 2, 0) / n;
    const stdev = Math.sqrt(variance);
    sharpe = {
      status: stdev > 0 ? 'OK' : 'INSUFFICIENT_SAMPLE',
      value: stdev > 0 ? avg / stdev : null,
      sampleSize: n,
    };
  }

  const downside = opts.tradePnls.filter((p) => p < 0);
  let sortino: MetricSample = {
    status: 'INSUFFICIENT_SAMPLE',
    value: null,
    sampleSize: n,
    reason: `Requires >= ${replaySafety.minSortinoTrades} closed trade P&Ls`,
  };
  if (n >= replaySafety.minSortinoTrades && avg != null) {
    if (!downside.length) {
      sortino = { status: 'INSUFFICIENT_SAMPLE', value: null, sampleSize: n, reason: 'No downside observations' };
    } else {
      const dVar = downside.reduce((s, v) => s + v ** 2, 0) / downside.length;
      const dStd = Math.sqrt(dVar);
      sortino = {
        status: dStd > 0 ? 'OK' : 'INSUFFICIENT_SAMPLE',
        value: dStd > 0 ? avg / dStd : null,
        sampleSize: n,
      };
    }
  }

  const perSymbol: ReplayPerformanceReport['perSymbol'] = {};
  const perStrategy: ReplayPerformanceReport['perStrategy'] = {};
  let buyNotional = 0;
  let sellNotional = 0;
  for (const tr of opts.trades) {
    const sym = perSymbol[tr.symbol] || { trades: 0, realizedPnl: 0, buyNotional: 0, sellNotional: 0 };
    sym.trades += 1;
    if (tr.realizedPnl != null) sym.realizedPnl += tr.realizedPnl;
    const notional = tr.quantity * tr.price;
    if (tr.side === 'BUY') {
      sym.buyNotional += notional;
      buyNotional += notional;
    } else {
      sym.sellNotional += notional;
      sellNotional += notional;
    }
    perSymbol[tr.symbol] = sym;

    const st = perStrategy[tr.strategyId] || { trades: 0, realizedPnl: 0 };
    st.trades += 1;
    if (tr.realizedPnl != null) st.realizedPnl += tr.realizedPnl;
    perStrategy[tr.strategyId] = st;
  }

  let exposure: MetricSample = { status: 'NOT_COMPUTED', value: null, reason: 'No equity curve' };
  if (opts.equityCurve.length) {
    const investedFrac = opts.equityCurve.map((e) => {
      const mv = e.equity - e.cash;
      return e.equity > 0 ? Math.max(0, mv / e.equity) : 0;
    });
    exposure = {
      status: 'OK',
      value: Number((mean(investedFrac) ?? 0).toFixed(6)),
      sampleSize: investedFrac.length,
      reason: 'Mean (equity-cash)/equity over portfolio snapshots',
    };
  }

  let turnover: MetricSample = { status: 'NOT_COMPUTED', value: null };
  if (opts.startingCapital > 0 && (buyNotional + sellNotional) > 0) {
    turnover = {
      status: 'OK',
      value: Number(((buyNotional + sellNotional) / opts.startingCapital).toFixed(6)),
      reason: 'Sum |trade notional| / starting capital',
    };
  } else if (!opts.trades.length) {
    turnover = { status: 'INSUFFICIENT_SAMPLE', value: null, reason: 'No fills' };
  }

  let benchmark: ReplayPerformanceReport['benchmark'] = {
    status: 'UNAVAILABLE',
    symbols: ['SPY', 'QQQ'],
    note: 'Benchmark buy-and-hold overlay not loaded for this replay (no PIT benchmark bars).',
    buyAndHoldReturnPct: null,
  };
  if (opts.benchmarkBars && opts.benchmarkBars.length >= 2) {
    const first = opts.benchmarkBars[0].close;
    const last = opts.benchmarkBars[opts.benchmarkBars.length - 1].close;
    if (first > 0) {
      benchmark = {
        status: 'OK',
        symbols: ['BENCHMARK'],
        note: 'Buy-and-hold of provided PIT benchmark series. Not proof of skill.',
        buyAndHoldReturnPct: Number((((last - first) / first) * 100).toFixed(4)),
      };
    }
  }

  const costs = replaySafety.costProfiles[opts.costProfile];
  const isZero =
    opts.costProfile === 'ZERO_COST_RESEARCH' ||
    (costs != null && costs.commissionPerShare === 0 && costs.spreadBps === 0 && costs.slippageBps === 0);

  const grossWin = wins.reduce((s, v) => s + v, 0);
  const grossLossAbs = Math.abs(losses.reduce((s, v) => s + v, 0));

  return {
    environment: 'HISTORICAL_REPLAY',
    notPaper: true,
    notLive: true,
    executionModel: 'NEXT_BAR_OPEN',
    costProfile: opts.costProfile,
    zeroCostWarning: isZero ? replaySafety.zeroCostWarning : null,
    startingCapital: opts.startingCapital,
    endingCapital: opts.endingCapital,
    netPnl: net,
    netReturnPct: opts.startingCapital ? (net / opts.startingCapital) * 100 : 0,
    grossPnl: opts.grossPnl,
    totalFees: opts.fees,
    totalSlippage: opts.slippage,
    maxDrawdown: opts.maxDrawdown,
    maxDrawdownPct: opts.maxDrawdownPct,
    sharpe,
    sortino,
    profitFactor: grossLossAbs > 0 ? grossWin / grossLossAbs : null,
    winRate: n ? wins.length / n : null,
    lossRate: n ? losses.length / n : null,
    averageWin: wins.length ? grossWin / wins.length : null,
    averageLoss: losses.length ? losses.reduce((s, v) => s + v, 0) / losses.length : null,
    expectancy: avg,
    totalTrades: n,
    buyTrades: opts.buyTrades,
    sellTrades: opts.sellTrades,
    shortTrades: 0,
    coverTrades: 0,
    exposure,
    turnover,
    perSymbol,
    perStrategy,
    benchmark,
    noTrade: opts.noTrade,
    honesty: [
      'HISTORICAL REPLAY is not PAPER and not LIVE.',
      'Replay P&L is not organic paper and cannot satisfy minPaperTrades.',
      'A profitable replay does not prove future profitability or LIVE readiness.',
      'Sharpe/Sortino withheld below min sample thresholds from replaySafety.json.',
      'COUNTERFACTUAL rejected-signal P&L is not mixed into net P&L.',
      'Canonical fill model is NEXT_BAR_OPEN (not same-bar close).',
      ...(isZero ? [replaySafety.zeroCostWarning] : []),
    ],
  };
}
