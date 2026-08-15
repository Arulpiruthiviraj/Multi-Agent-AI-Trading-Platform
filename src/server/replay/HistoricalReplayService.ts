/**
 * Additive research replay. Does not replace BacktestEngine or run live AI inside ReplayClock.
 */
import { backtestEngine } from '../engines/backtest/BacktestEngine';
import { computeFailureBreakdown } from '../quant/analysis/FailureClassification';
import { aiHistoricalReplayAvailability } from './aiReplayAvailability';
import { buildReplayLedger, overconfidenceFlags } from './buildReplayLedger';

export async function runHistoricalReplay(body: {
  mode?: string;
  strategyId?: string;
  symbol?: string;
  startDate?: string;
  endDate?: string;
  timeframe?: string;
  initialCash?: number;
  verboseLogging?: boolean;
}) {
  const mode = (body.mode || 'QUANT_STRATEGY').toUpperCase();
  const ai = aiHistoricalReplayAvailability();
  if (mode === 'AI' || mode === 'AI_CONSENSUS' || mode === 'HYBRID') {
    return {
      ok: true,
      mode,
      aiReplay: ai,
      ledger: [],
      note: 'AI/hybrid historical replay is not executed. Quant-strategy ReplayClock path remains available via mode=QUANT_STRATEGY.',
    };
  }
  if (!body.strategyId || !body.symbol || !body.startDate || !body.endDate) {
    throw new Error('QUANT_STRATEGY replay requires strategyId, symbol, startDate, and endDate.');
  }
  const result = await backtestEngine.runStrategyBacktest({
    strategyId: body.strategyId,
    symbol: body.symbol,
    startDate: body.startDate,
    endDate: body.endDate,
    timeframe: body.timeframe,
    initialCash: body.initialCash,
    verboseLogging: !!body.verboseLogging,
  });
  const tradeLog = result.tradeLog || [];
  const ledger = buildReplayLedger(tradeLog, body.symbol);
  return {
    ok: true,
    mode: 'QUANT_STRATEGY',
    aiReplay: ai,
    runId: result.runId,
    metrics: {
      totalTrades: result.totalTrades,
      winRatePct: result.winRatePct,
      profitFactor: result.profitFactor,
      expectancy: result.expectancy,
      sharpe: result.sharpe,
      sortino: result.sortino,
      maxDrawdownPct: result.maxDrawdownPct,
      finalEquity: result.finalEquity,
    },
    benchmarkComparison: result.benchmarkComparison || null,
    failureBreakdown: computeFailureBreakdown(tradeLog),
    overconfidence: overconfidenceFlags(ledger),
    ledger,
  };
}
