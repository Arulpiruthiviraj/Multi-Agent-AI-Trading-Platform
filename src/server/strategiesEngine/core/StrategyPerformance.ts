/**
 * ==========================================================
 * Module: strategiesEngine/core/StrategyPerformance
 *
 * Purpose:
 * Future-compatible interfaces for strategy performance results and ranking, per the build
 * directive's Sections 17-18. NOTHING in this file computes a performance number - there is no
 * backtest runner here and this module makes no claim that any cataloged strategy is profitable.
 * A future phase (BacktestEngine or a new backtest adapter) would populate a StrategyPerformance
 * object from real trade results and pass it in; nothing here fabricates one.
 * ==========================================================
 */

export interface StrategyPerformance {
  strategyId: string;
  /** Real date range the performance was measured over - required so a caller can never present
   *  a performance object without knowing what period it covers. */
  periodStart: string; // ISO date
  periodEnd: string; // ISO date
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  profitFactor: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  expectancy: number;
  averageWin: number;
  averageLoss: number;
  maxDrawdown: number;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  calmarRatio: number | null;
  recoveryFactor: number | null;
  averageHoldingTimeBars: number | null;
  exposure: number | null; // fraction of the period with an open position
  turnover: number | null;
  /** Whether this measurement came from real backtest trades, real paper trades, or real live
   *  trades - never omitted, so a ranking view can't silently blend incomparable sources. */
  source: 'BACKTEST' | 'PAPER' | 'LIVE';
}

export type RankingCriterion =
  | 'SHARPE' | 'SORTINO' | 'PROFIT_FACTOR' | 'EXPECTANCY' | 'MAX_DRAWDOWN'
  | 'CONSISTENCY' | 'RISK_ADJUSTED_RETURN' | 'TRADE_COUNT' | 'ROBUSTNESS' | 'OUT_OF_SAMPLE';

export interface StrategyRankingInput {
  strategyId: string;
  performance: StrategyPerformance;
}

/** A ranked entry carries the real performance record it was ranked from - never a bare score
 *  with no traceable source, and never a ranking of a strategy that has no real performance yet. */
export interface RankedStrategy {
  strategyId: string;
  rank: number;
  criterion: RankingCriterion;
  value: number;
  performance: StrategyPerformance;
}

/**
 * Pure ranking function over REAL performance records supplied by the caller - this module never
 * generates its own performance data. Strategies with no performance record are not ranked (there
 * is no "0 score" fallback - that would misleadingly imply a measured result).
 */
export function rankStrategies(inputs: StrategyRankingInput[], criterion: RankingCriterion): RankedStrategy[] {
  const valueOf = (p: StrategyPerformance): number | null => {
    switch (criterion) {
      case 'SHARPE': return p.sharpeRatio;
      case 'SORTINO': return p.sortinoRatio;
      case 'PROFIT_FACTOR': return p.profitFactor;
      case 'EXPECTANCY': return p.expectancy;
      case 'MAX_DRAWDOWN': return -p.maxDrawdown; // lower drawdown ranks higher
      case 'CONSISTENCY': return p.winRate;
      case 'RISK_ADJUSTED_RETURN': return p.calmarRatio;
      case 'TRADE_COUNT': return p.totalTrades;
      case 'ROBUSTNESS': return p.recoveryFactor;
      case 'OUT_OF_SAMPLE': return null; // requires a caller-supplied OOS record, not this generic path
      default: return null;
    }
  };

  return inputs
    .map(i => ({ i, value: valueOf(i.performance) }))
    .filter((x): x is { i: StrategyRankingInput; value: number } => x.value !== null && Number.isFinite(x.value))
    .sort((a, b) => b.value - a.value)
    .map((x, idx) => ({
      strategyId: x.i.strategyId,
      rank: idx + 1,
      criterion,
      value: x.value,
      performance: x.i.performance,
    }));
}
