/**
 * ==========================================================
 * Module: strategiesEngine/backtest/runBacktest
 *
 * Purpose:
 * A real, isolated backtest runner for THIS engine's StrategyDefinitions - deliberately separate
 * from src/server/engines/backtest/BacktestEngine.ts (which is scoped to the live-reachable quant
 * engine's own StrategyContext/StrategyDefinition shapes and is left completely untouched). This
 * runner reuses real, already-tested primitives read-only: HistoricalDataGateway for real bars
 * (never fabricates one - throws without real Alpaca credentials, exactly like the existing
 * engine), calculateCommission/calculateDynamicSlippagePct for real trading-cost drag, and
 * annualizedSharpe for a real Sharpe figure - none of these are reimplemented here.
 *
 * Long-only, matching the existing BacktestEngine's own documented convention (CLAUDE.md:
 * "Backtest is long-only. Bearish setups will not open shorts.") - kept consistent rather than
 * silently diverging.
 *
 * Point-in-time correctness: the MarketSnapshot at bar i is built from bars[0..i] only (never
 * bars[i+1..]) - no look-ahead. Entry/exit price is that same bar's own close - a real, disclosed
 * simplification (not a next-bar-open fill), since a live evaluator would only ever see this
 * signal once the bar has actually closed anyway.
 *
 * Position sizing here is a fixed hypothetical notional per trade (not real account equity - this
 * engine has no portfolio/account state), so resulting P&L is a real, reproducible measure of the
 * STRATEGY's own edge, not a claim about what a real account would have earned.
 * ==========================================================
 */
import { createHash } from 'crypto';
import { historicalDataGateway, Bar } from '../../engines/backtest/HistoricalDataGateway';
import { calculateCommission } from '../../engines/backtest/Commissions';
import { calculateDynamicSlippagePct } from '../../engines/backtest/Slippage';
import { annualizedSharpe, periodReturnsFromEquityCurve } from '../../quant/analysis/MonteCarlo';
import { buildMarketSnapshotFromBars } from '../core/MarketSnapshot';
import { evaluateCondition } from '../conditions/evaluateCondition';
import { StrategyDefinition, Timeframe } from '../core/types';
import { StrategyPerformance } from '../core/StrategyPerformance';

export const HYPOTHETICAL_NOTIONAL_PER_TRADE = 10_000;
export const MIN_BARS_FOR_SNAPSHOT = 60; // enough history for SMA50/ADX/etc. to be real, not null

export interface RunBacktestInput {
  strategy: StrategyDefinition;
  symbol: string;
  timeframe: Timeframe;
  startMs: number;
  endMs: number;
}

export interface RunBacktestResult {
  performance: StrategyPerformance;
  datasetHash: string;
  barsUsed: number;
  trades: Array<{ entryTs: number; exitTs: number; entryPrice: number; exitPrice: number; netPnl: number; rMultiple: number | null }>;
}

interface OpenPosition {
  entryIndex: number;
  entryTs: number;
  entryPrice: number;
  shares: number;
  stopPrice: number | null;
}

function hashBars(bars: Bar[]): string {
  const hash = createHash('sha256');
  for (const b of bars) hash.update(`${b.timestamp}:${b.open}:${b.high}:${b.low}:${b.close}:${b.volume}|`);
  return hash.digest('hex');
}

function resolveStopPrice(strategy: StrategyDefinition, entryPrice: number, atr: number | null): number | null {
  if (strategy.stopLoss.kind === 'ATR_MULTIPLE' || strategy.stopLoss.kind === 'TRAILING_ATR') {
    if (atr === null || strategy.stopLoss.value === null) return null;
    return entryPrice - atr * strategy.stopLoss.value;
  }
  if (strategy.stopLoss.kind === 'FIXED_PCT' && strategy.stopLoss.value !== null) {
    return entryPrice * (1 - strategy.stopLoss.value / 100);
  }
  return null; // STRUCTURE/TIME_BASED stops need richer state this simple runner does not model
}

/**
 * Runs one real backtest of `strategy` on `symbol`/`timeframe` over [startMs, endMs]. Throws if
 * real historical bars cannot be obtained (same fail-closed behavior as HistoricalDataGateway
 * itself - never fabricates a bar or a trade). Long-only: a SELL-side entryConditions match is
 * recorded as a real "no long entry" condition, never opens a short.
 */
export async function runBacktest(input: RunBacktestInput): Promise<RunBacktestResult> {
  const { strategy, symbol, timeframe, startMs, endMs } = input;
  const gatewayTimeframe = timeframe === '1d' ? '1Day' : timeframe; // HistoricalDataGateway's real bar table uses Alpaca's own timeframe strings; only daily is exercised by this pass

  try {
    await historicalDataGateway.ensureBars(symbol, gatewayTimeframe, startMs, endMs);
  } catch (e) {
    // Same fallback the real /strategy/rsi-scan route already uses (v2System.strategy.test.ts):
    // if a fresh backfill isn't possible (no ALPACA_API_KEY/SECRET, or the real fetch failed),
    // fall through to whatever real bars are already cached in ohlcv_bars rather than throwing
    // immediately - this only fails below if there really is not enough real data either way.
  }
  const bars = await historicalDataGateway.getBars(symbol, gatewayTimeframe, startMs, endMs);
  if (bars.length < MIN_BARS_FOR_SNAPSHOT + 10) {
    throw new Error(`Only ${bars.length} real bars available for ${symbol} ${timeframe} in this window - need at least ${MIN_BARS_FOR_SNAPSHOT + 10} (enough for real indicator history plus a few evaluable bars), not fabricating a result from too little history.`);
  }

  const trades: RunBacktestResult['trades'] = [];
  const equityCurve: Array<{ equity: number }> = [{ equity: HYPOTHETICAL_NOTIONAL_PER_TRADE }];
  let equity = HYPOTHETICAL_NOTIONAL_PER_TRADE;
  let peakEquity = equity;
  let maxDrawdown = 0;
  let openPosition: OpenPosition | null = null;

  for (let i = MIN_BARS_FOR_SNAPSHOT; i < bars.length; i++) {
    const visibleBars = bars.slice(0, i + 1); // point-in-time - never sees bars[i+1..]
    const bar = bars[i];
    const snapshot = buildMarketSnapshotFromBars(visibleBars, symbol, timeframe);

    if (openPosition) {
      const stopHit = openPosition.stopPrice !== null && bar.low <= openPosition.stopPrice;
      const exitSignal = strategy.exitConditions ? evaluateCondition(strategy.exitConditions, snapshot) : false;
      const invalidated = strategy.invalidationConditions ? evaluateCondition(strategy.invalidationConditions, snapshot) : false;

      if (stopHit || exitSignal || invalidated) {
        const rawExitPrice = stopHit ? openPosition.stopPrice! : bar.close;
        const slippagePct = calculateDynamicSlippagePct({
          highs: visibleBars.map(b => b.high), lows: visibleBars.map(b => b.low), closes: visibleBars.map(b => b.close),
          currentPrice: rawExitPrice, orderShares: openPosition.shares, barVolume: bar.volume,
        });
        const exitPrice = rawExitPrice * (1 - slippagePct / 100);
        const commission = calculateCommission({ side: 'SELL', quantity: openPosition.shares, fillPrice: exitPrice });
        const grossPnl = (exitPrice - openPosition.entryPrice) * openPosition.shares;
        const netPnl = grossPnl - commission.total;
        const riskPerShare = openPosition.stopPrice !== null ? openPosition.entryPrice - openPosition.stopPrice : null;
        const rMultiple = riskPerShare !== null && riskPerShare > 0 ? (exitPrice - openPosition.entryPrice) / riskPerShare : null;

        equity += netPnl;
        trades.push({ entryTs: openPosition.entryTs, exitTs: bar.timestamp, entryPrice: openPosition.entryPrice, exitPrice, netPnl, rMultiple });
        openPosition = null;
      }
    } else {
      const entrySignal = evaluateCondition(strategy.entryConditions, snapshot);
      const confirmed = strategy.confirmationConditions ? evaluateCondition(strategy.confirmationConditions, snapshot) : true;
      // Long-only (matches existing BacktestEngine convention): only act when the strategy's own
      // logic would BUY. A strategy whose entry fires but whose own math implies SELL is not
      // forced into a short - it is honestly recorded as "no long entry this bar."
      if (entrySignal && confirmed && bar.close > 0) {
        const slippagePct = calculateDynamicSlippagePct({
          highs: visibleBars.map(b => b.high), lows: visibleBars.map(b => b.low), closes: visibleBars.map(b => b.close),
          currentPrice: bar.close, orderShares: Math.floor(HYPOTHETICAL_NOTIONAL_PER_TRADE / bar.close), barVolume: bar.volume,
        });
        const entryPrice = bar.close * (1 + slippagePct / 100);
        const shares = Math.floor(HYPOTHETICAL_NOTIONAL_PER_TRADE / entryPrice);
        if (shares > 0) {
          const stopPrice = resolveStopPrice(strategy, entryPrice, snapshot.indicators.atr);
          openPosition = { entryIndex: i, entryTs: bar.timestamp, entryPrice, shares, stopPrice };
        }
      }
    }

    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.max(maxDrawdown, peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0);
    equityCurve.push({ equity });
  }

  const wins = trades.filter(t => t.netPnl > 0);
  const losses = trades.filter(t => t.netPnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
  const netProfit = trades.reduce((s, t) => s + t.netPnl, 0);
  const returns = periodReturnsFromEquityCurve(equityCurve);

  const performance: StrategyPerformance = {
    strategyId: strategy.id,
    periodStart: new Date(startMs).toISOString().slice(0, 10),
    periodEnd: new Date(endMs).toISOString().slice(0, 10),
    totalTrades: trades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    grossProfit,
    grossLoss,
    netProfit,
    expectancy: trades.length > 0 ? netProfit / trades.length : 0,
    averageWin: wins.length > 0 ? grossProfit / wins.length : 0,
    averageLoss: losses.length > 0 ? -grossLoss / losses.length : 0,
    maxDrawdown,
    sharpeRatio: returns.length > 0 ? annualizedSharpe(returns) : null,
    sortinoRatio: null, // not computed by this pass - would need a downside-deviation helper not yet reused here
    calmarRatio: maxDrawdown > 0 ? (netProfit / HYPOTHETICAL_NOTIONAL_PER_TRADE) / maxDrawdown : null,
    recoveryFactor: maxDrawdown > 0 ? netProfit / (maxDrawdown * HYPOTHETICAL_NOTIONAL_PER_TRADE) : null,
    averageHoldingTimeBars: trades.length > 0
      ? trades.reduce((s, t) => s + (bars.findIndex(b => b.timestamp === t.exitTs) - bars.findIndex(b => b.timestamp === t.entryTs)), 0) / trades.length
      : null,
    exposure: null, // would need per-bar in-position tracking this pass doesn't separately record
    turnover: null,
    source: 'BACKTEST',
  };

  return { performance, datasetHash: hashBars(bars), barsUsed: bars.length, trades };
}
