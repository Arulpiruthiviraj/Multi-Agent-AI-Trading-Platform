import { replaySafety } from './replaySafety';
import type { ReplayTradeRecord } from './ReplayContext';

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
