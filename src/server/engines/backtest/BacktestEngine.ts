/**
 * ==========================================================
 * Module: BacktestEngine
 *
 * Purpose:
 * A real historical replay engine. Runs the same deterministic technical
 * rules TechnicalAgent.ts uses live (momentum breakout, mean reversion,
 * overbought exit, plus a fixed stop-loss/take-profit) against real,
 * point-in-time-gated historical bars, simulates execution with a spread
 * cost, and computes real performance metrics from the resulting trade log.
 *
 * Scope, honestly stated: this backtests the deterministic technical
 * strategy (and named quant strategies via runStrategyBacktest) against
 * point-in-time bars. Fill model is SAME_BAR_CLOSE (signal and fill on the
 * same bar close). Results are quarantined from promotion
 * (promotable:false / SAME_BAR_CLOSE_NOT_PROMOTABLE). Canonical research
 * promotion uses NEXT_BAR_OPEN only (canonicalNextBarEngine).
 * Each simulated BUY is evaluated by evaluatePitRisk
 * (the live RiskEngine gate ladder on simulated state). NewsAgent and
 * ChiefTrader LLM debate are not replayed unless rows exist in
 * pit_decision_ledger with publishedAtMs <= the simulated clock.
 * ==========================================================
 */
import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import * as schema from '../../db/schema';
import { historicalDataGateway, Bar } from './HistoricalDataGateway';
import { ReplayClock } from './ReplayClock';
import { rsiEngine } from '../RSIEngine';
import { macdEngine } from '../MACDEngine';
import { CORRELATION_MIN_OVERLAP, getSector } from '../PositionSizing';
import { calculateCommission } from './Commissions';
import { executionModelVersion, stampSameBarPromotionQuarantine } from '../../research/executionModel';
import { calculateDynamicSlippagePct } from './Slippage';
import { classifyRegime, RegimeLabel, MIN_BARS as REGIME_MIN_BARS } from '../../quant/RegimeEngine';
import { getMarketContext, BarsFetcher, BENCHMARK_SYMBOLS, SECTOR_ETF_MAP } from '../../quant/MarketContext';
import { computeMomentumFeatures } from '../../quant/indicators/momentum';
import { computeVolumeFeatures } from '../../quant/indicators/volume';
import { computeSupportResistanceFeatures } from '../../quant/indicators/supportResistance';
import { computeSmcFeatures } from '../../quant/indicators/smc';
import { ALL_STRATEGIES, EXPERIMENTAL_STRATEGIES, findStrategy, MIN_STRATEGY_CONFIDENCE_TO_TRADE } from '../../quant/strategies/StrategyEngine';
import { StrategyContext } from '../../quant/strategies/types';
import { expectedValue, fractionalKelly, ExpectedValueResult, KellyResult } from '../../quant/risk/ExpectedValue';
import { classifyTradeFailure, computeFailureBreakdown } from '../../quant/analysis/FailureClassification';
import { tradingSafety, portfolioRiskPctForLevel } from '../../config/tradingSafety';
import { buildAccountSizeReport } from '../../quant/analysis/AccountSizeReport';
import {
  nySessionKey,
} from './BacktestRiskParity';
import { evaluatePitRisk } from './PitRiskEngine';
import { evaluatePitAiBuyGate } from './PitReplay';
import { permutationTestSharpe, periodReturnsFromEquityCurve } from '../../quant/analysis/MonteCarlo';
import { isPositiveFiniteMoney } from '../AccountEquity';
import { getTradingDateStr } from '../../core/TradingCalendar';

export interface BacktestConfig {
  symbols: string[];
  startDate: string; // ISO date, e.g. '2024-01-01'
  endDate: string;
  timeframe?: string; // Alpaca timeframe string, default '1Day'
  initialCash?: number;
}

interface SimulatedTrade {
  symbol: string;
  side: 'BUY' | 'SELL';
  timestamp: number;
  price: number;
  quantity: number;
  confidence: number;
  reasoning: string;
  realizedPnl?: number;
  // Phase 2B (FINAL_ANALYSIS.md's 4-phase remediation plan) - real trading-cost drag, previously
  // absent entirely. slippagePct is the dynamic, volatility/size-scaled rate actually applied to
  // this specific fill (Slippage.ts), not a flat constant - kept per-trade for transparency.
  commission?: number;
  slippagePct?: number;
}

interface OpenPosition {
  symbol: string;
  quantity: number;
  entryPrice: number;
}

// Phase 10 of the additive quant layer - per-strategy, per-regime backtesting via
// runStrategyBacktest() below. A separate, additive trade-log shape from SimulatedTrade above
// (entryRegime/rMultiple have no meaning for the existing single hardcoded strategy run() backtests
// - kept as its own type rather than bolting optional fields onto SimulatedTrade).
interface StrategyTrade {
  side: 'BUY' | 'SELL';
  timestamp: number;
  price: number;
  quantity: number;
  realizedPnl?: number;
  commission?: number;
  slippagePct?: number;
  entryRegime?: RegimeLabel;
  rMultiple?: number; // real P&L expressed in units of the ORIGINAL (entry-time) stop distance - never recomputed against a trailed stop, since R is conventionally measured against the risk actually taken at entry
  // E4 - only ever set on a losing SELL (realizedPnl < 0), from FailureClassification.ts.
  failureCategory?: string;
  failureDetail?: string;
}

export interface StrategyBacktestConfig {
  strategyId: string;
  symbol: string;
  startDate: string;
  endDate: string;
  timeframe?: string;
  initialCash?: number;
  /** E3 (BACKTEST_QUANT_HARDENING_ANALYSIS.md) - opt-in, off by default. When true, writes one
   * quant_backtest_decision_log row per candidate bar (every bar the strategy is evaluated while
   * flat), recording conditions met/failed, contradictions, regime, and why the candidate did or
   * didn't become a trade - not just the final trade log. Off by default because a multi-year
   * daily backtest evaluates thousands of candidate bars per run, most of which never trade. */
  verboseLogging?: boolean;
}

const LOOKBACK = tradingSafety.backtestLookbackBars;
const PERIODS_PER_YEAR = tradingSafety.tradingDaysPerYear;
const MIN_SAMPLE_SIZE_FOR_TRUST = tradingSafety.minSampleSizeForTrust;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
function strengthToConfidence(strength01: number): number {
  return Number((0.55 + 0.40 * clamp01(strength01)).toFixed(3));
}

function resolveSimulatedStartingCash(initialCash: number | undefined): number {
  if (initialCash === undefined) return tradingSafety.internalPaperDefaultCash;
  if (!isPositiveFiniteMoney(initialCash)) {
    throw new Error('INVALID_ACCOUNT_EQUITY: backtest initialCash is missing or not positive. No phantom starting cash.');
  }
  return initialCash;
}

export class BacktestEngine {
  async run(config: BacktestConfig): Promise<any> {
    const runId = crypto.randomUUID();
    const timeframe = config.timeframe || '1Day';
    const initialCash = resolveSimulatedStartingCash(config.initialCash);
    const startMs = new Date(config.startDate).getTime();
    const endMs = new Date(config.endDate).getTime();

    if (!config.symbols || config.symbols.length === 0) throw new Error('At least one symbol is required.');
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
      throw new Error('startDate must be a valid date before endDate.');
    }

    await db.insert(schema.backtestRuns).values({
      id: runId,
      createdAt: new Date().toISOString(),
      status: 'RUNNING',
      symbols: JSON.stringify(config.symbols),
      startDate: config.startDate,
      endDate: config.endDate,
      timeframe,
      initialCash,
    });

    try {
      const barsBySymbol: Record<string, Bar[]> = {};
      const corporateActionsWarnings: string[] = [];
      for (const symbol of config.symbols) {
        await historicalDataGateway.ensureBars(symbol, timeframe, startMs, endMs);
        const bars = await historicalDataGateway.getBars(symbol, timeframe, startMs, endMs);
        if (bars.length < LOOKBACK) {
          throw new Error(`Only ${bars.length} real bars available for ${symbol} in this range - need at least ${LOOKBACK} to evaluate the strategy's lookback window. Widen the date range.`);
        }
        barsBySymbol[symbol] = bars;

        // Phase 2C - real corporate-actions safety check. Bars above are always adjustment='raw'
        // (unadjusted for splits/dividends) - an unadjusted split in this window would silently
        // corrupt every bar before the split date. Halts the run rather than producing a result
        // built on corrupted data; only skipped (never silently assumed clean) when it genuinely
        // could not be checked (e.g. no Alpaca credentials), which is recorded honestly instead.
        const corpActionsCheck = await historicalDataGateway.checkForUnadjustedCorporateActions(symbol, timeframe, startMs, endMs);
        if (corpActionsCheck.checked && !corpActionsCheck.clean) {
          throw new Error(`CORPORATE_ACTION_DETECTED: ${symbol} has an unadjusted stock split/corporate action within this date range that would corrupt PnL if the backtest proceeded on raw data. Details: ${corpActionsCheck.issues.join(' | ')}`);
        }
        if (!corpActionsCheck.checked) {
          corporateActionsWarnings.push(...corpActionsCheck.issues);
        }
      }

      type TimelineEvent = { symbol: string; index: number; timestamp: number };
      const timeline: TimelineEvent[] = [];
      for (const symbol of config.symbols) {
        barsBySymbol[symbol].forEach((bar, index) => timeline.push({ symbol, index, timestamp: bar.timestamp }));
      }
      timeline.sort((a, b) => a.timestamp - b.timestamp);

      // Phase 2A - real settings, the exact same config live RiskEngine.evaluateRisk() reads
      // (maxTradeSize/riskLevel/maxOpenPositions), so backtest sizing genuinely reflects what live
      // trading would actually have allowed instead of an arbitrary backtest-only rule.
      const liveSettings = await db.select().from(schema.settings).limit(1);
      // Real bug fixed: maxTradeSizeDollar's fallback and maxPortfolioRiskPct's per-riskLevel
      // values used to be literals duplicated from RiskEngine.ts/tradingSafety.json instead of
      // reading the same config - they happened to match today, but config/tradingSafety.json's
      // riskPctAggressive/Conservative/Balanced or defaultMaxTradeSizeDollars could be retuned
      // without this file's numbers following, silently making backtest sizing diverge from what
      // live RiskEngine would actually have allowed for the same nominal inputs.
      const maxTradeSizeDollar = liveSettings[0]?.maxTradeSize ?? tradingSafety.defaultMaxTradeSizeDollars;
      const riskLevel = liveSettings[0]?.riskLevel ?? 'Balanced';
      const maxPortfolioRiskPct = portfolioRiskPctForLevel(riskLevel);
      const maxOpenPositions = liveSettings[0]?.maxOpenPositions ?? 10;
      // E2A (BACKTEST_QUANT_HARDENING_ANALYSIS.md) - previously hardcoded -0.05/0.15 literals in
      // the exit check below with no connection to settings.trailingStopPct/takeProfitPct, the
      // exact same fields PortfolioMonitor.ts now also reads live - this closes the live/backtest
      // exit-assumption mismatch the audit flagged, in both directions at once.
      const takeProfitPct = (liveSettings[0]?.takeProfitPct ?? 15) / 100;
      const trailingStopPct = (liveSettings[0]?.trailingStopPct ?? 5) / 100;
      // E2B - feature-flagged, defaults to 'FIXED_DOLLAR' (today's exact behavior).
      const sizingMode = (liveSettings[0]?.positionSizingMode as 'FIXED_DOLLAR' | 'PERCENT_OF_EQUITY') || 'FIXED_DOLLAR';
      const percentOfEquityPct = liveSettings[0]?.percentOfEquityPct ?? 2;
      const maxPortfolioDrawdownPct = liveSettings[0]?.maxPortfolioDrawdownPct ?? 0.15;
      const dailyLossLimitDollars = liveSettings[0]?.dailyLossLimit ?? 5000;
      const maxOrdersPerMinute = liveSettings[0]?.maxOrdersPerMinute ?? 5;
      const configuredBudget = Number(liveSettings[0]?.budget);
      const allocatedBudget = Number.isFinite(configuredBudget) && configuredBudget > 0 ? configuredBudget : initialCash;

      // Point-in-time-safe closes lookup for the correlation-exposure gate - only ever bars
      // already visible up to the simulated clock, and only among symbols this backtest actually
      // has data for (a real, honest limitation: an existing position's real portfolio might hold
      // other symbols outside this run's universe, which correlation cannot be checked against).
      const getRecentClosesAtSimTime = (clock: ReplayClock) => async (symbol: string): Promise<number[] | null> => {
        const bars = barsBySymbol[symbol];
        if (!bars) return null;
        const visible = bars.filter(b => b.timestamp <= clock.now());
        if (visible.length < CORRELATION_MIN_OVERLAP) return null;
        return visible.slice(-90).map(b => b.close);
      };

      const clock = new ReplayClock(timeline[0].timestamp);
      const getRecentCloses = getRecentClosesAtSimTime(clock);
      let cash = initialCash;
      const positions: Record<string, OpenPosition> = {};
      const equityCurve: { timestamp: number; equity: number }[] = [];
      const tradeLog: SimulatedTrade[] = [];
      let peakEquity = initialCash;
      let dayKey = nySessionKey(timeline[0].timestamp);
      let dayStartEquity = initialCash;
      const buyTimestampsMs: number[] = [];

      // Real point-in-time equity: cash plus every open position valued at its own last real
      // close visible as of the simulated clock - used both for sizing decisions (accountEquity
      // must reflect current equity, not the fixed initial cash the old flat-10% rule used) and
      // for the equity curve pushed below.
      const computeEquity = (): number => {
        let posValue = 0;
        for (const s of Object.keys(positions)) {
          const p = positions[s];
          const barsForS = barsBySymbol[s];
          let lastClose = p.entryPrice;
          for (let i = barsForS.length - 1; i >= 0; i--) {
            if (barsForS[i].timestamp <= clock.now()) { lastClose = barsForS[i].close; break; }
          }
          posValue += p.quantity * lastClose;
        }
        return cash + posValue;
      };

      for (const evt of timeline) {
        clock.advance(evt.timestamp);

        // The loop only ever exposes a chronological PREFIX of this symbol's bars - the
        // strategy below can structurally never see bar[evt.index + 1] or later. The assertion
        // is defense-in-depth on top of that structural guarantee.
        const allBars = barsBySymbol[evt.symbol];
        const visibleBars = allBars.slice(0, evt.index + 1);
        clock.assertNotFuture(visibleBars[visibleBars.length - 1].timestamp, `${evt.symbol} bar`);
        if (visibleBars.length < LOOKBACK) continue;

        const window = visibleBars.slice(-LOOKBACK).map(b => b.close);
        const highsWindow = visibleBars.slice(-LOOKBACK).map(b => b.high);
        const lowsWindow = visibleBars.slice(-LOOKBACK).map(b => b.low);
        const currentBar = visibleBars[visibleBars.length - 1];
        const currentPrice = window[window.length - 1];
        const sma20 = window.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const sma50 = window.reduce((a, b) => a + b, 0) / window.length;
        const rsi = rsiEngine.calculate(window);
        const macd = macdEngine.calculate(window);
        const bbSlice = window.slice(-20);
        const bbSma = bbSlice.reduce((a, b) => a + b, 0) / 20;
        const bbStd = Math.sqrt(bbSlice.reduce((s, p) => s + Math.pow(p - bbSma, 2), 0) / 20);
        const bbUpper = bbSma + bbStd * 2;
        const bbLower = bbSma - bbStd * 2;

        const pos = positions[evt.symbol];
        let signal: 'BUY' | 'SELL' | null = null;
        let confidence = 0;
        let reasoning = '';

        if (!pos && currentPrice > sma20 && sma20 > sma50 && rsi > 50 && rsi < 70 && macd.macd > macd.signal) {
          const rsiStrength = clamp01((rsi - 50) / 20);
          const macdStrength = clamp01((macd.macd - macd.signal) / (currentPrice * 0.005));
          const trendStrength = clamp01((sma20 - sma50) / (currentPrice * 0.02));
          confidence = strengthToConfidence((rsiStrength + macdStrength + trendStrength) / 3);
          signal = 'BUY'; reasoning = 'Momentum breakout';
        } else if (!pos && rsi < 30 && currentPrice < bbLower) {
          const rsiStrength = clamp01((30 - rsi) / 30);
          const bw = bbUpper - bbLower;
          const bbStrength = bw > 0 ? clamp01((bbLower - currentPrice) / bw) : 0;
          confidence = strengthToConfidence((rsiStrength + bbStrength) / 2);
          signal = 'BUY'; reasoning = 'Mean reversion';
        } else if (pos && rsi > 75 && currentPrice > bbUpper) {
          signal = 'SELL'; confidence = 0.70; reasoning = 'Overbought exit';
        } else if (pos) {
          const changePct = (currentPrice - pos.entryPrice) / pos.entryPrice;
          if (changePct <= -trailingStopPct) { signal = 'SELL'; confidence = 0.60; reasoning = `Stop-loss (-${(trailingStopPct * 100).toFixed(1)}%)`; }
          else if (changePct >= takeProfitPct) { signal = 'SELL'; confidence = 0.60; reasoning = `Take-profit (+${(takeProfitPct * 100).toFixed(1)}%)`; }
        }

        const equityNow = computeEquity();
        if (equityNow > peakEquity) peakEquity = equityNow;
        const session = nySessionKey(evt.timestamp);
        if (session !== dayKey) {
          dayKey = session;
          dayStartEquity = equityNow;
        }
        const closedPnlsNewestFirst = tradeLog
          .filter(t => t.side === 'SELL' && typeof t.realizedPnl === 'number')
          .map(t => t.realizedPnl as number)
          .reverse();
        const pitNews = await historicalDataGateway.getPitNewsAsOf(evt.symbol, evt.timestamp);
        const existingPositions = Object.values(positions).map(p => ({ symbol: p.symbol, quantity: p.quantity, averagePrice: p.entryPrice }));
        const prevBarTs = visibleBars.length >= 2
          ? visibleBars[visibleBars.length - 2].timestamp
          : evt.timestamp - tradingSafety.evaluationHorizonMs;
        const pitAiRows = await historicalDataGateway.getPitAiRowsAsOf(evt.symbol, evt.timestamp, prevBarTs);
        const pitAi = evaluatePitAiBuyGate(pitAiRows, evt.symbol, currentPrice);

        if (signal === 'BUY' && confidence >= 0.55 && pitAi.allowBuy) {
          const meanFinbert = pitNews.length > 0
            ? pitNews.reduce((s, n) => s + (n.finbertScore ?? 0), 0) / pitNews.length
            : null;
          if (meanFinbert !== null) {
            reasoning = `${reasoning}; FinBERT=${meanFinbert.toFixed(3)}`;
          }
          if (pitAi.replay) {
            reasoning = `${reasoning}; ${pitAi.replay.reason}`;
          }
          const pit = await evaluatePitRisk({
            nowMs: evt.timestamp,
            timeframe,
            tradingState: 'TRADING_ENABLED',
            side: 'BUY',
            symbol: evt.symbol,
            currentPrice,
            equityNow,
            buyingPower: cash,
            dayStartEquity,
            dailyLossLimitDollars,
            peakEquity,
            maxPortfolioDrawdownPct,
            recentClosedPnlsNewestFirst: closedPnlsNewestFirst,
            buyTimestampsMs,
            maxOrdersPerMinute,
            existingPositions,
            maxTradeSizeDollar,
            maxPortfolioRiskPct,
            maxOpenPositions,
            getRecentCloses,
            sizingMode,
            percentOfEquityPct,
            allocatedBudget,
            tradingMode: 'PAPER',
            dailyBuyRows: tradeLog.filter(t => t.side === 'BUY').map(t => ({
              side: 'BUY', status: 'FILLED', price: t.price, quantity: t.quantity,
              timestamp: new Date(t.timestamp).toISOString(),
            })),
            pitNews,
            barTimestampMs: currentBar.timestamp,
          });
          const qty = pit.maxQuantity;
          if (pit.approved && qty > 0) {
            // Phase 2B - real dynamic slippage (volatility + participation-rate scaled), sized
            // against the order this sizing pass actually approved, then real regulatory
            // commission (SEC fee/FINRA TAF are sells-only, so $0 here - see Commissions.ts).
            const slippagePct = calculateDynamicSlippagePct({ highs: highsWindow, lows: lowsWindow, closes: window, currentPrice, orderShares: qty, barVolume: currentBar.volume });
            const fillPrice = currentPrice * (1 + slippagePct);
            const commission = calculateCommission({ side: 'BUY', quantity: qty, fillPrice }).total;
            cash -= qty * fillPrice + commission;
            positions[evt.symbol] = { symbol: evt.symbol, quantity: qty, entryPrice: fillPrice };
            buyTimestampsMs.push(evt.timestamp);
            tradeLog.push({ symbol: evt.symbol, side: 'BUY', timestamp: evt.timestamp, price: fillPrice, quantity: qty, confidence, reasoning, commission, slippagePct });
          }
        } else if (signal === 'SELL' && pos) {
          const slippagePct = calculateDynamicSlippagePct({ highs: highsWindow, lows: lowsWindow, closes: window, currentPrice, orderShares: pos.quantity, barVolume: currentBar.volume });
          const fillPrice = currentPrice * (1 - slippagePct);
          const commission = calculateCommission({ side: 'SELL', quantity: pos.quantity, fillPrice }).total;
          const realizedPnl = Number(((fillPrice - pos.entryPrice) * pos.quantity - commission).toFixed(2));
          cash += pos.quantity * fillPrice - commission;
          delete positions[evt.symbol];
          tradeLog.push({ symbol: evt.symbol, side: 'SELL', timestamp: evt.timestamp, price: fillPrice, quantity: pos.quantity, confidence, reasoning, realizedPnl, commission, slippagePct });
        }

        equityCurve.push({ timestamp: evt.timestamp, equity: Number(computeEquity().toFixed(2)) });
      }

      // Liquidate any still-open positions at the last known real price for final accounting -
      // real slippage/commission applied here too, not a bare close-price fill.
      for (const s of Object.keys(positions)) {
        const p = positions[s];
        const barsForS = barsBySymbol[s];
        const lastBar = barsForS[barsForS.length - 1];
        const tailHighs = barsForS.slice(-LOOKBACK).map(b => b.high);
        const tailLows = barsForS.slice(-LOOKBACK).map(b => b.low);
        const tailCloses = barsForS.slice(-LOOKBACK).map(b => b.close);
        const slippagePct = calculateDynamicSlippagePct({ highs: tailHighs, lows: tailLows, closes: tailCloses, currentPrice: lastBar.close, orderShares: p.quantity, barVolume: lastBar.volume });
        const fillPrice = lastBar.close * (1 - slippagePct);
        const commission = calculateCommission({ side: 'SELL', quantity: p.quantity, fillPrice }).total;
        const realizedPnl = Number(((fillPrice - p.entryPrice) * p.quantity - commission).toFixed(2));
        cash += p.quantity * fillPrice - commission;
        tradeLog.push({ symbol: s, side: 'SELL', timestamp: lastBar.timestamp, price: fillPrice, quantity: p.quantity, confidence: 1, reasoning: 'End-of-backtest liquidation', realizedPnl, commission, slippagePct });
      }

      const finalEquity = Number(cash.toFixed(2));
      const metrics = this.computeMetrics(initialCash, equityCurve, tradeLog, startMs, endMs);

      await db.update(schema.backtestRuns).set({
        status: 'COMPLETED',
        finalEquity,
        totalTrades: tradeLog.length,
        winRate: metrics.winRatePct,
        profitFactor: metrics.profitFactor,
        sharpeRatio: metrics.sharpe,
        sortinoRatio: metrics.sortino,
        maxDrawdownPct: metrics.maxDrawdownPct,
        cagr: metrics.cagrPct,
        expectancy: metrics.expectancy,
        equityCurve: JSON.stringify(equityCurve),
        tradeLog: JSON.stringify(tradeLog),
      }).where(eq(schema.backtestRuns.id, runId));

      const statisticalSignificance = permutationTestSharpe(periodReturnsFromEquityCurve(equityCurve));
      return stampSameBarPromotionQuarantine({
        id: runId, status: 'COMPLETED', initialCash, finalEquity, totalReturnPct: metrics.totalReturnPct, ...metrics, trades: tradeLog.length, equityCurve, tradeLog, statisticalSignificance,
        executionModelVersion: executionModelVersion(),
      });
    } catch (e: any) {
      await db.update(schema.backtestRuns).set({ status: 'FAILED', errorMessage: e.message }).where(eq(schema.backtestRuns.id, runId));
      throw e;
    }
  }

  async getRun(id: string) {
    const rows = await db.select().from(schema.backtestRuns).where(eq(schema.backtestRuns.id, id)).limit(1);
    return rows[0] ? stampSameBarPromotionQuarantine({ ...rows[0] } as Record<string, unknown>) : null;
  }

  async listRuns() {
    const rows = await db.select().from(schema.backtestRuns);
    return rows.map((r) => stampSameBarPromotionQuarantine({ ...r } as Record<string, unknown>));
  }

  async getStrategyRun(id: string) {
    const rows = await db.select().from(schema.quantStrategyBacktests).where(eq(schema.quantStrategyBacktests.id, id)).limit(1);
    return rows[0] ? stampSameBarPromotionQuarantine({ ...rows[0] } as Record<string, unknown>) : null;
  }

  async listStrategyRuns() {
    const rows = await db.select().from(schema.quantStrategyBacktests);
    return rows.map((r) => stampSameBarPromotionQuarantine({ ...r } as Record<string, unknown>));
  }

  /**
   * Phase 10 of the additive quant layer - real per-strategy, per-regime backtesting for exactly
   * ONE named strategy from strategies/StrategyEngine.ts, against exactly ONE symbol. A separate
   * method from run() above (which stays completely untouched) - not a mode flag on it - because
   * the decision logic, position model (long-only, matching this codebase's real no-short-selling
   * broker capability), and result shape are all genuinely different from the existing hardcoded-
   * technical-strategy backtest.
   *
   * Reuses every piece of REAL existing infrastructure run() already uses (HistoricalDataGateway,
   * ReplayClock's look-ahead-bias guard, calculatePositionSizing, Commissions, Slippage,
   * computeMetrics) - the new logic here is only: (a) building a real point-in-time StrategyContext
   * each bar (the exact same construction QuantSignalAgent.ts uses live, just fed from the replay
   * loop instead of a live timer) and calling the named strategy's own evaluate(), (b) a real
   * long-only entry/exit/trailing-stop simulation driven by that strategy's own stop/target
   * suggestions, and (c) real regime-segmented results plus a real backtest-derived expected-value/
   * Kelly readout (quant/risk/ExpectedValue.ts) - using this backtest's own actual win rate and
   * realized R-multiples, never an assumed/guessed probability.
   */
  async runStrategyBacktest(config: StrategyBacktestConfig): Promise<any> {
    const strategy = findStrategy(config.strategyId);
    if (!strategy) {
      const known = [...ALL_STRATEGIES, ...EXPERIMENTAL_STRATEGIES].map(s => s.id).join(', ');
      throw new Error(`Unknown strategy id "${config.strategyId}". Real strategies: ${known}.`);
    }

    const runId = crypto.randomUUID();
    const timeframe = config.timeframe || '1Day';
    const initialCash = resolveSimulatedStartingCash(config.initialCash);
    const startMs = new Date(config.startDate).getTime();
    const endMs = new Date(config.endDate).getTime();
    const symbol = config.symbol;

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
      throw new Error('startDate must be a valid date before endDate.');
    }

    await db.insert(schema.quantStrategyBacktests).values({
      id: runId, strategyId: config.strategyId, symbol, timeframe,
      startDate: config.startDate, endDate: config.endDate, status: 'RUNNING', initialCash,
      createdAt: new Date().toISOString(),
    });

    try {
      await historicalDataGateway.ensureBars(symbol, timeframe, startMs, endMs);
      const bars = await historicalDataGateway.getBars(symbol, timeframe, startMs, endMs);
      if (bars.length < REGIME_MIN_BARS) {
        throw new Error(`Only ${bars.length} real bars available for ${symbol} in this range - need at least ${REGIME_MIN_BARS} for a real regime/strategy read. Widen the date range.`);
      }

      const corpActionsCheck = await historicalDataGateway.checkForUnadjustedCorporateActions(symbol, timeframe, startMs, endMs);
      if (corpActionsCheck.checked && !corpActionsCheck.clean) {
        throw new Error(`CORPORATE_ACTION_DETECTED: ${symbol} has an unadjusted stock split/corporate action within this date range that would corrupt PnL if the backtest proceeded on raw data. Details: ${corpActionsCheck.issues.join(' | ')}`);
      }

      // Pre-fetch benchmark/sector bars ONCE (real ohlcv_bars, same source MarketContext.ts always
      // uses) - point-in-time-safe slicing happens per-step below via pointInTimeSafeFetchBars,
      // mirroring run()'s own getRecentClosesAtSimTime pattern for correlation lookups above.
      const sectorName = getSector(symbol);
      const sectorEtf = sectorName ? SECTOR_ETF_MAP[sectorName] : null;
      const benchmarkSymbols = Array.from(new Set([BENCHMARK_SYMBOLS.broad, BENCHMARK_SYMBOLS.tech, BENCHMARK_SYMBOLS.smallCap, ...(sectorEtf ? [sectorEtf] : [])]));
      const benchmarkBars: Record<string, Bar[]> = {};
      for (const bSymbol of benchmarkSymbols) {
        // Matches MarketContext.ts's own benchmarkTrend() honest-degradation behavior: a genuinely
        // unavailable benchmark (ensureBars() throws when it can find literally zero real bars
        // anywhere, not just "nothing new to fetch") must not abort the whole backtest - it just
        // means marketContext.spy/qqq/iwm/sector.trend.regime is null for this run, exactly as it
        // would be live if that benchmark's data were unavailable.
        try {
          await historicalDataGateway.ensureBars(bSymbol, timeframe, startMs, endMs);
          benchmarkBars[bSymbol] = await historicalDataGateway.getBars(bSymbol, timeframe, startMs, endMs);
        } catch {
          benchmarkBars[bSymbol] = [];
        }
      }
      const pointInTimeSafeFetchBars: BarsFetcher = async (bSymbol, _tf, _startMs, endBoundaryMs) => {
        const all = benchmarkBars[bSymbol] || [];
        return all.filter(b => b.timestamp <= endBoundaryMs);
      };

      const liveSettings = await db.select().from(schema.settings).limit(1);
      // Real bug fixed: same drift risk as run() above - these used to be literals duplicated
      // from tradingSafety.json instead of reading it, see that comment for the full rationale.
      const maxTradeSizeDollar = liveSettings[0]?.maxTradeSize ?? tradingSafety.defaultMaxTradeSizeDollars;
      const riskLevel = liveSettings[0]?.riskLevel ?? 'Balanced';
      const maxPortfolioRiskPct = portfolioRiskPctForLevel(riskLevel);
      // E2B - same feature-flagged sizing mode run() now reads (see its own comment above).
      const sizingMode = (liveSettings[0]?.positionSizingMode as 'FIXED_DOLLAR' | 'PERCENT_OF_EQUITY') || 'FIXED_DOLLAR';
      const percentOfEquityPct = liveSettings[0]?.percentOfEquityPct ?? 2;
      const maxPortfolioDrawdownPct = liveSettings[0]?.maxPortfolioDrawdownPct ?? 0.15;
      const dailyLossLimitDollars = liveSettings[0]?.dailyLossLimit ?? 5000;
      const maxOrdersPerMinute = liveSettings[0]?.maxOrdersPerMinute ?? 5;
      const takeProfitPct = (liveSettings[0]?.takeProfitPct ?? 15) / 100;
      const trailingStopPct = (liveSettings[0]?.trailingStopPct ?? 5) / 100;
      const configuredBudget = Number(liveSettings[0]?.budget);
      const allocatedBudget = Number.isFinite(configuredBudget) && configuredBudget > 0 ? configuredBudget : initialCash;

      const clock = new ReplayClock(bars[0].timestamp);
      let cash = initialCash;
      let position: {
        quantity: number; entryPrice: number; entryStopPrice: number; entryRegime: RegimeLabel;
        // E4 - captured at entry (free, already computed) so a later loss can be classified
        // without depending on verboseLogging having been enabled for this run.
        entryContradictions: string[]; entrySlippagePct: number;
      } | null = null;
      let trackedStop: number | null = null;
      const equityCurve: { timestamp: number; equity: number }[] = [];
      const tradeLog: StrategyTrade[] = [];
      let peakEquity = initialCash;
      let drawdownCircuitBreakerTriggeredAt: number | null = null;
      let dayKey = nySessionKey(bars[0].timestamp);
      let dayStartEquity = initialCash;
      const buyTimestampsMs: number[] = [];

      const computeEquity = (currentPrice: number) => cash + (position ? position.quantity * currentPrice : 0);

      for (let i = 0; i < bars.length; i++) {
        clock.advance(bars[i].timestamp);
        const visibleBars = bars.slice(0, i + 1);
        clock.assertNotFuture(visibleBars[visibleBars.length - 1].timestamp, `${symbol} bar`);
        if (visibleBars.length < REGIME_MIN_BARS) continue;

        const currentBar = visibleBars[visibleBars.length - 1];
        const currentPrice = currentBar.close;

        // Phase 2 - real high-water-mark tracking + drawdown circuit breaker, mirroring
        // RiskEngine.ts's live `portfolio_drawdown` gate (which tracks a real persisted peak
        // equity the same way). Computed every bar, before any entry decision this bar.
        const equityNow = computeEquity(currentPrice);
        if (equityNow > peakEquity) peakEquity = equityNow;
        const currentDrawdownPct = peakEquity > 0 ? Math.max(0, (peakEquity - equityNow) / peakEquity) : 0;
        if (currentDrawdownPct >= maxPortfolioDrawdownPct && drawdownCircuitBreakerTriggeredAt === null) {
          drawdownCircuitBreakerTriggeredAt = currentBar.timestamp;
          console.warn(`[BacktestEngine] ${symbol}/${strategy.id}: drawdown circuit breaker tripped at bar ${new Date(currentBar.timestamp).toISOString()} (${(currentDrawdownPct * 100).toFixed(1)}% from peak, threshold ${(maxPortfolioDrawdownPct * 100).toFixed(1)}%) - no new positions will be opened for the remainder of this run, matching RiskEngine's real live behavior.`);
        }

        // The exact same StrategyContext construction QuantSignalAgent.ts uses live - only the
        // source of `visibleBars` differs (a point-in-time-gated replay slice here, the full real
        // history there). Never re-derives indicator math a second way.
        const regime = classifyRegime(visibleBars);
        const marketContext = await getMarketContext(symbol, visibleBars, timeframe, startMs, currentBar.timestamp, pointInTimeSafeFetchBars);
        const strategyContext: StrategyContext = {
          symbol, currentPrice,
          trend: regime.features.trend,
          volatility: regime.features.volatility,
          priceAction: regime.features.priceAction,
          momentum: computeMomentumFeatures(visibleBars),
          volume: computeVolumeFeatures(visibleBars),
          supportResistance: computeSupportResistanceFeatures(visibleBars),
          regime, marketContext,
          // Same SMC snapshot as live QuantSignalAgent so backtests of SMC_LIQUIDITY_SWEEP see real features.
          smc: computeSmcFeatures(visibleBars),
        };
        const evaluation = strategy.evaluate(strategyContext);
        const recentHighs = visibleBars.slice(-LOOKBACK).map(b => b.high);
        const recentLows = visibleBars.slice(-LOOKBACK).map(b => b.low);
        const recentCloses = visibleBars.slice(-LOOKBACK).map(b => b.close);

        const session = nySessionKey(currentBar.timestamp);
        if (session !== dayKey) {
          dayKey = session;
          dayStartEquity = equityNow;
        }
        const closedPnlsNewestFirst = tradeLog
          .filter(t => t.side === 'SELL' && typeof t.realizedPnl === 'number')
          .map(t => t.realizedPnl as number)
          .reverse();

        if (!position) {
          // E3 - verbose per-candidate decision trace (opt-in). Populated below regardless of
          // which branch this candidate takes; written once at the end of the `!position` block
          // so every real BUY candidate gets exactly one row, whether it entered or was rejected.
          let decisionOutcome = 'REJECTED_LOW_CONFIDENCE';
          let decisionReason = `confidence ${evaluation.confidence.toFixed(3)} below the ${MIN_STRATEGY_CONFIDENCE_TO_TRADE} threshold to trade`;
          let sizingGatesForLog: any = null;
          let sizingQtyForLog = 0;

          if (drawdownCircuitBreakerTriggeredAt !== null) {
            decisionOutcome = 'REJECTED_DRAWDOWN_CIRCUIT_BREAKER';
            decisionReason = `Portfolio drawdown circuit breaker tripped at ${new Date(drawdownCircuitBreakerTriggeredAt).toISOString()} - no new positions opened for the rest of this run, matching RiskEngine's real live portfolio_drawdown gate.`;
          }

          // Long-only entries - matches this codebase's real broker capability (no adapter
          // anywhere supports short selling; every real broker reports shortSelling:false), the
          // same real scope run()'s own existing hardcoded strategy already has (its SELL signal
          // only ever closes an existing long, never opens a fresh short).
          if (drawdownCircuitBreakerTriggeredAt === null && evaluation.side === 'BUY' && evaluation.confidence >= MIN_STRATEGY_CONFIDENCE_TO_TRADE && evaluation.stop.price !== null) {
            const prevBarTs = visibleBars.length >= 2
              ? visibleBars[visibleBars.length - 2].timestamp
              : currentBar.timestamp - tradingSafety.evaluationHorizonMs;
            const pitAiRows = await historicalDataGateway.getPitAiRowsAsOf(symbol, currentBar.timestamp, prevBarTs);
            const pitAi = evaluatePitAiBuyGate(pitAiRows, symbol, currentPrice, { allowTechnicalWhenEmpty: true });
            if (!pitAi.allowBuy) {
              decisionOutcome = 'REJECTED_PIT_AI_CONSENSUS';
              decisionReason = pitAi.replay?.reason ?? 'PIT AI ledger present but BUY not approved';
            }
            const pitNews = await historicalDataGateway.getPitNewsAsOf(symbol, currentBar.timestamp);
            if (pitAi.allowBuy) {
            const pit = await evaluatePitRisk({
              nowMs: currentBar.timestamp,
              timeframe,
              tradingState: 'TRADING_ENABLED',
              side: 'BUY',
              symbol,
              currentPrice,
              equityNow,
              buyingPower: cash,
              dayStartEquity,
              dailyLossLimitDollars,
              peakEquity,
              maxPortfolioDrawdownPct,
              recentClosedPnlsNewestFirst: closedPnlsNewestFirst,
              buyTimestampsMs,
              maxOrdersPerMinute,
              existingPositions: [],
              maxTradeSizeDollar,
              maxPortfolioRiskPct,
              maxOpenPositions: 1,
              getRecentCloses: async () => null,
              sizingMode,
              percentOfEquityPct,
              allocatedBudget,
              tradingMode: 'PAPER',
              dailyBuyRows: tradeLog.filter(t => t.side === 'BUY').map(t => ({
                side: 'BUY', status: 'FILLED', price: t.price, quantity: t.quantity,
                timestamp: new Date(t.timestamp).toISOString(),
              })),
              pitNews,
              barTimestampMs: currentBar.timestamp,
            });
            sizingGatesForLog = pit.gateResults;
            sizingQtyForLog = pit.maxQuantity;
            const qty = pit.approved ? pit.maxQuantity : 0;
            if (qty > 0) {
              const slippagePct = calculateDynamicSlippagePct({ highs: recentHighs, lows: recentLows, closes: recentCloses, currentPrice, orderShares: qty, barVolume: currentBar.volume });
              const fillPrice = currentPrice * (1 + slippagePct);
              const commission = calculateCommission({ side: 'BUY', quantity: qty, fillPrice }).total;
              cash -= qty * fillPrice + commission;
              position = {
                quantity: qty, entryPrice: fillPrice, entryStopPrice: evaluation.stop.price, entryRegime: regime.regime,
                entryContradictions: evaluation.contradictions, entrySlippagePct: slippagePct,
              };
              trackedStop = evaluation.stop.price;
              tradeLog.push({ side: 'BUY', timestamp: currentBar.timestamp, price: fillPrice, quantity: qty, commission, slippagePct });
              buyTimestampsMs.push(currentBar.timestamp);
              decisionOutcome = 'ENTERED';
              decisionReason = `entered ${qty} shares @ ${fillPrice.toFixed(2)} (${sizingMode})`;
            } else {
              decisionOutcome = 'REJECTED_ZERO_SIZE';
              decisionReason = pit.approved
                ? 'position sizing gates produced zero quantity - see sizingGates for the binding constraint'
                : pit.reasoning;
            }
            }
          } else if (evaluation.side === 'BUY' && evaluation.stop.price === null) {
            decisionOutcome = 'REJECTED_NO_STOP';
            decisionReason = 'strategy did not produce a stop price for this candidate';
          }

          // SELL-while-flat is not a real long-only candidate (matches the silent no-op this
          // branch already had) - only BUY candidates are logged, since only those were ever
          // real entry decisions.
          if (config.verboseLogging && evaluation.side === 'BUY') {
            await db.insert(schema.quantBacktestDecisionLog).values({
              id: crypto.randomUUID(), backtestRunId: runId, symbol, timestamp: currentBar.timestamp,
              regime: regime.regime, side: evaluation.side, setupScore: evaluation.setupScore, confidence: evaluation.confidence,
              conditionsMet: JSON.stringify(evaluation.conditionsMet), conditionsFailed: JSON.stringify(evaluation.conditionsFailed),
              contradictions: JSON.stringify(evaluation.contradictions), sizingQuantity: sizingQtyForLog,
              sizingGates: sizingGatesForLog ? JSON.stringify(sizingGatesForLog) : null,
              outcome: decisionOutcome, reason: decisionReason, createdAt: new Date().toISOString(),
            });
          }

        } else {
          // Trail the stop UP only, never loosen it - the same strategy's fresh per-bar suggestion
          // is exactly how trendFollowing.ts's intentionally-open-ended SMA50 trailing stop is meant
          // to be used; for strategies with a fixed stop, this is a no-op (their stop doesn't move).
          if (evaluation.stop.price !== null && trackedStop !== null && evaluation.stop.price > trackedStop) {
            trackedStop = evaluation.stop.price;
          }

          const stopHit = trackedStop !== null && currentBar.low <= trackedStop;
          const changePct = (currentPrice - position.entryPrice) / position.entryPrice;
          const liveTrailHit = changePct <= -trailingStopPct;
          const liveTakeProfitHit = changePct >= takeProfitPct;
          if (stopHit || liveTrailHit || liveTakeProfitHit) {
            const exitPrice = stopHit ? trackedStop! : currentPrice;
            const slippagePct = calculateDynamicSlippagePct({ highs: recentHighs, lows: recentLows, closes: recentCloses, currentPrice: exitPrice, orderShares: position.quantity, barVolume: currentBar.volume });
            const fillPrice = exitPrice * (1 - slippagePct);
            const commission = calculateCommission({ side: 'SELL', quantity: position.quantity, fillPrice }).total;
            const realizedPnl = Number(((fillPrice - position.entryPrice) * position.quantity - commission).toFixed(2));
            const riskPerShareAtEntry = Math.abs(position.entryPrice - position.entryStopPrice);
            const rMultiple = riskPerShareAtEntry > 0 ? Number(((fillPrice - position.entryPrice) / riskPerShareAtEntry).toFixed(3)) : undefined;
            cash += position.quantity * fillPrice - commission;
            // E4 - only classify real losses; a winning/breakeven trade has no failure to explain.
            const failure = realizedPnl < 0 ? classifyTradeFailure({
              entryRegime: position.entryRegime, applicableRegimes: strategy.applicableRegimes,
              entryContradictions: position.entryContradictions, rMultiple,
              entrySlippagePct: position.entrySlippagePct, exitSlippagePct: slippagePct,
            }) : null;
            tradeLog.push({ side: 'SELL', timestamp: currentBar.timestamp, price: fillPrice, quantity: position.quantity, realizedPnl, commission, slippagePct, entryRegime: position.entryRegime, rMultiple, failureCategory: failure?.category, failureDetail: failure?.detail });
            position = null;
            trackedStop = null;
          }
        }

        equityCurve.push({ timestamp: currentBar.timestamp, equity: Number(computeEquity(currentPrice).toFixed(2)) });
      }

      // End-of-backtest liquidation of any still-open position - same real slippage/commission
      // treatment as run()'s own liquidation step, never a bare close-price fill.
      if (position) {
        const lastBar = bars[bars.length - 1];
        const tailHighs = bars.slice(-LOOKBACK).map(b => b.high);
        const tailLows = bars.slice(-LOOKBACK).map(b => b.low);
        const tailCloses = bars.slice(-LOOKBACK).map(b => b.close);
        const slippagePct = calculateDynamicSlippagePct({ highs: tailHighs, lows: tailLows, closes: tailCloses, currentPrice: lastBar.close, orderShares: position.quantity, barVolume: lastBar.volume });
        const fillPrice = lastBar.close * (1 - slippagePct);
        const commission = calculateCommission({ side: 'SELL', quantity: position.quantity, fillPrice }).total;
        const realizedPnl = Number(((fillPrice - position.entryPrice) * position.quantity - commission).toFixed(2));
        const riskPerShareAtEntry = Math.abs(position.entryPrice - position.entryStopPrice);
        const rMultiple = riskPerShareAtEntry > 0 ? Number(((fillPrice - position.entryPrice) / riskPerShareAtEntry).toFixed(3)) : undefined;
        cash += position.quantity * fillPrice - commission;
        const failure = realizedPnl < 0 ? classifyTradeFailure({
          entryRegime: position.entryRegime, applicableRegimes: strategy.applicableRegimes,
          entryContradictions: position.entryContradictions, rMultiple,
          entrySlippagePct: position.entrySlippagePct, exitSlippagePct: slippagePct,
        }) : null;
        tradeLog.push({ side: 'SELL', timestamp: lastBar.timestamp, price: fillPrice, quantity: position.quantity, realizedPnl, commission, slippagePct, entryRegime: position.entryRegime, rMultiple, failureCategory: failure?.category, failureDetail: failure?.detail });
      }

      const finalEquity = Number(cash.toFixed(2));
      const baseMetrics = this.computeMetrics(initialCash, equityCurve, tradeLog as any, startMs, endMs);
      const regimeBreakdown = this.computeRegimeBreakdown(tradeLog);
      const { avgWinR, avgLossR, avgR, maxConsecutiveLosses } = this.computeRMetrics(tradeLog);

      // Real, backtest-derived EV/Kelly - uses THIS backtest's own actual win rate and realized
      // R-multiples, never an assumed probability. fractionalKelly() itself refuses below its own
      // minimum real sample size, so `kelly` can be a real, honestly-unjustified result even when
      // `ev` is computable (EV only needs a win rate + R:R, not a large sample to be a real number -
      // it just may not be a RELIABLE one yet, which insufficientSampleSize already flags).
      let ev: ExpectedValueResult | null = null;
      let kelly: KellyResult | null = null;
      if (avgWinR !== null && avgLossR !== null && avgLossR > 0) {
        const rr = avgWinR / avgLossR;
        ev = expectedValue(baseMetrics.winRatePct / 100, rr);
        kelly = fractionalKelly(baseMetrics.winRatePct / 100, rr, baseMetrics.closedTrades);
      }

      // E7 - real buy-and-hold comparison, computed from bars this run already loaded (the
      // traded symbol's own first/last close, and SPY's over the same window) - never a second
      // fetch, never an assumed benchmark return. A day-trading-style strategy is never judged by
      // total return alone elsewhere in this report (Sharpe/Sortino/drawdown are also reported),
      // but "did this beat just buying and holding" is a real, standard question worth answering.
      const buyAndHoldReturnPct = (b: Bar[]): number | null => {
        if (b.length < 2) return null;
        const first = b[0].close, last = b[b.length - 1].close;
        return first > 0 ? Number((((last - first) / first) * 100).toFixed(2)) : null;
      };
      const symbolBuyAndHoldReturnPct = buyAndHoldReturnPct(bars);
      const spyBarsInWindow = (benchmarkBars[BENCHMARK_SYMBOLS.broad] || []).filter(b => b.timestamp >= startMs && b.timestamp <= endMs);
      const spyBuyAndHoldReturnPct = buyAndHoldReturnPct(spyBarsInWindow);
      const benchmarkComparison = {
        strategyReturnPct: baseMetrics.totalReturnPct,
        symbolBuyAndHoldReturnPct,
        spyBuyAndHoldReturnPct,
        outperformedSymbolBuyAndHold: symbolBuyAndHoldReturnPct !== null ? baseMetrics.totalReturnPct > symbolBuyAndHoldReturnPct : null,
        outperformedSpyBuyAndHold: spyBuyAndHoldReturnPct !== null ? baseMetrics.totalReturnPct > spyBuyAndHoldReturnPct : null,
      };

      await db.update(schema.quantStrategyBacktests).set({
        status: 'COMPLETED',
        finalEquity,
        totalTrades: tradeLog.length,
        winRatePct: baseMetrics.winRatePct,
        profitFactor: baseMetrics.profitFactor,
        sharpe: baseMetrics.sharpe,
        sortino: baseMetrics.sortino,
        maxDrawdownPct: baseMetrics.maxDrawdownPct,
        expectancy: baseMetrics.expectancy,
        avgWinR, avgLossR, avgR, maxConsecutiveLosses,
        regimeBreakdown: JSON.stringify(regimeBreakdown),
        expectedValue: ev ? JSON.stringify(ev) : null,
        kelly: kelly ? JSON.stringify(kelly) : null,
        tradeLog: JSON.stringify(tradeLog),
        equityCurve: JSON.stringify(equityCurve),
        benchmarkComparison: JSON.stringify(benchmarkComparison),
      }).where(eq(schema.quantStrategyBacktests.id, runId));

      // E4 - real distribution over the categories this engine can honestly derive, recomputed
      // from tradeLog[].failureCategory (set inline at each SELL above) - never persisted as a
      // separate column, so it can never drift from the trade log it summarizes.
      const failureBreakdown = computeFailureBreakdown(tradeLog);

      // E7 - honest capital-utilization scenarios using this run's own real starting price. Not
      // persisted (this table doesn't archive raw bars, so a later GET can't recompute it) -
      // present only in this live return value, matching a "generated fresh per run" scope.
      const accountSizeReport = buildAccountSizeReport(bars[0].close);

      const statisticalSignificance = permutationTestSharpe(periodReturnsFromEquityCurve(equityCurve));
      return stampSameBarPromotionQuarantine({
        id: runId, status: 'COMPLETED', strategyId: config.strategyId, symbol, initialCash, finalEquity,
        ...baseMetrics, avgWinR, avgLossR, avgR, maxConsecutiveLosses, regimeBreakdown,
        expectedValue: ev, kelly, trades: tradeLog.length, equityCurve, tradeLog, failureBreakdown,
        benchmarkComparison, accountSizeReport, statisticalSignificance,
        drawdownCircuitBreakerTriggeredAt,
        executionModelVersion: executionModelVersion(),
      });
    } catch (e: any) {
      await db.update(schema.quantStrategyBacktests).set({ status: 'FAILED', errorMessage: e.message }).where(eq(schema.quantStrategyBacktests.id, runId));
      throw e;
    }
  }

  /** Groups closed trades by the real regime active at entry, per the plan's own "evaluate
   *  performance by market regime" instruction - never fabricates a count/rate for a regime that
   *  had zero real trades (simply absent from the returned object, not a fabricated 0%). */
  private computeRegimeBreakdown(tradeLog: StrategyTrade[]): Record<string, { count: number; winRatePct: number; expectancy: number }> {
    const closed = tradeLog.filter(t => t.side === 'SELL' && typeof t.realizedPnl === 'number' && t.entryRegime);
    const byRegime = new Map<RegimeLabel, StrategyTrade[]>();
    for (const t of closed) {
      const key = t.entryRegime!;
      if (!byRegime.has(key)) byRegime.set(key, []);
      byRegime.get(key)!.push(t);
    }
    const result: Record<string, { count: number; winRatePct: number; expectancy: number }> = {};
    for (const [regime, trades] of byRegime.entries()) {
      const wins = trades.filter(t => (t.realizedPnl ?? 0) > 0);
      const losses = trades.filter(t => (t.realizedPnl ?? 0) <= 0);
      const winRatePct = Number(((wins.length / trades.length) * 100).toFixed(1));
      const avgWin = wins.length ? wins.reduce((s, t) => s + (t.realizedPnl ?? 0), 0) / wins.length : 0;
      const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + (t.realizedPnl ?? 0), 0)) / losses.length : 0;
      const expectancy = Number((((winRatePct / 100) * avgWin) - ((1 - winRatePct / 100) * avgLoss)).toFixed(2));
      result[regime] = { count: trades.length, winRatePct, expectancy };
    }
    return result;
  }

  /** Real average winning/losing R-multiple and max real consecutive-loss streak - the two Phase
   *  10 metrics confirmed absent from computeMetrics() (which stays untouched, still used by
   *  run()). R-multiples are measured against each trade's OWN entry-time stop distance, never a
   *  trailed stop, per the standard convention. */
  private computeRMetrics(tradeLog: StrategyTrade[]): { avgWinR: number | null; avgLossR: number | null; avgR: number | null; maxConsecutiveLosses: number } {
    const closedWithR = tradeLog.filter(t => t.side === 'SELL' && typeof t.rMultiple === 'number');
    const rValues = closedWithR.map(t => t.rMultiple!);
    const avgR = rValues.length ? Number((rValues.reduce((a, b) => a + b, 0) / rValues.length).toFixed(3)) : null;

    const winRs = rValues.filter(r => r > 0);
    const lossRs = rValues.filter(r => r <= 0).map(r => Math.abs(r));
    const avgWinR = winRs.length ? Number((winRs.reduce((a, b) => a + b, 0) / winRs.length).toFixed(3)) : null;
    const avgLossR = lossRs.length ? Number((lossRs.reduce((a, b) => a + b, 0) / lossRs.length).toFixed(3)) : null;

    let maxConsecutiveLosses = 0;
    let current = 0;
    for (const t of tradeLog) {
      if (t.side !== 'SELL' || typeof t.realizedPnl !== 'number') continue;
      if (t.realizedPnl <= 0) { current++; maxConsecutiveLosses = Math.max(maxConsecutiveLosses, current); }
      else current = 0;
    }

    return { avgWinR, avgLossR, avgR, maxConsecutiveLosses };
  }

  private computeMetrics(initialCash: number, equityCurve: { timestamp: number; equity: number }[], tradeLog: SimulatedTrade[], startMs: number, endMs: number) {
    const finalEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : initialCash;
    const totalReturnPct = ((finalEquity - initialCash) / initialCash) * 100;
    const years = (endMs - startMs) / (365.25 * 24 * 60 * 60 * 1000);
    const cagrPct = years > 0 && finalEquity > 0 ? (Math.pow(finalEquity / initialCash, 1 / years) - 1) * 100 : 0;

    const returns: number[] = [];
    for (let i = 1; i < equityCurve.length; i++) {
      const prev = equityCurve[i - 1].equity;
      const cur = equityCurve[i].equity;
      if (prev > 0) returns.push((cur - prev) / prev);
    }
    const meanRet = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const stdRet = returns.length ? Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - meanRet, 2), 0) / returns.length) : 0;
    const downside = returns.filter(r => r < 0);
    const downsideStd = downside.length ? Math.sqrt(downside.reduce((s, r) => s + Math.pow(r, 2), 0) / downside.length) : 0;
    // Real bug fixed: this used to always annualize with sqrt(252) (a daily-bar assumption)
    // regardless of the backtest's actual timeframe. BacktestConfig.timeframe/
    // StrategyBacktestConfig.timeframe accept arbitrary Alpaca intervals ('1Min', '15Min',
    // '1Hour', ...) with no validation restricting them to daily, so a non-daily backtest
    // annualized Sharpe/Sortino as if it had ~252 observations/year when it actually had far more
    // (e.g. hourly RTH bars: ~252*6.5 ≈ 1638/year) - understating annualized Sharpe by roughly
    // that same factor. Derived from real bars/trading-day inferred from equityCurve's own
    // timestamps via the same trading-calendar bucketing RiskEngine uses elsewhere (NOT raw
    // calendar-time spacing - that would wrongly count weekend gaps and change daily-bar
    // annualization from 252 to 365.25, a regression for the default/dominant case). For real
    // daily bars this is mathematically identical to the old constant (1 bar/trading day * 252 =
    // 252); it only changes behavior for genuinely intraday backtests.
    const periodsPerYear = (() => {
      if (equityCurve.length < 3) return PERIODS_PER_YEAR;
      const distinctTradingDays = new Set(equityCurve.map((pt) => getTradingDateStr(new Date(pt.timestamp))));
      if (distinctTradingDays.size === 0) return PERIODS_PER_YEAR;
      const barsPerTradingDay = equityCurve.length / distinctTradingDays.size;
      const inferred = barsPerTradingDay * PERIODS_PER_YEAR;
      return Number.isFinite(inferred) && inferred > 0 ? inferred : PERIODS_PER_YEAR;
    })();
    const sharpe = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(periodsPerYear) : 0;
    const sortino = downsideStd > 0 ? (meanRet / downsideStd) * Math.sqrt(periodsPerYear) : 0;

    let peak = -Infinity;
    let maxDD = 0;
    for (const pt of equityCurve) {
      peak = Math.max(peak, pt.equity);
      const dd = peak > 0 ? (peak - pt.equity) / peak : 0;
      maxDD = Math.max(maxDD, dd);
    }

    const closedTrades = tradeLog.filter(t => t.side === 'SELL' && typeof t.realizedPnl === 'number');
    const wins = closedTrades.filter(t => (t.realizedPnl ?? 0) > 0);
    const losses = closedTrades.filter(t => (t.realizedPnl ?? 0) <= 0);
    const winRatePct = closedTrades.length ? (wins.length / closedTrades.length) * 100 : 0;
    const grossProfit = wins.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.realizedPnl ?? 0), 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? null : 0);
    const avgWin = wins.length ? grossProfit / wins.length : 0;
    const avgLoss = losses.length ? grossLoss / losses.length : 0;
    const expectancy = closedTrades.length ? ((winRatePct / 100) * avgWin - (1 - winRatePct / 100) * avgLoss) : 0;

    return {
      totalReturnPct: Number(totalReturnPct.toFixed(2)),
      cagrPct: Number(cagrPct.toFixed(2)),
      sharpe: Number(sharpe.toFixed(2)),
      sortino: Number(sortino.toFixed(2)),
      maxDrawdownPct: Number((maxDD * 100).toFixed(2)),
      winRatePct: Number(winRatePct.toFixed(1)),
      profitFactor: profitFactor === null ? null : Number(profitFactor.toFixed(2)),
      expectancy: Number(expectancy.toFixed(2)),
      closedTrades: closedTrades.length,
      insufficientSampleSize: closedTrades.length < MIN_SAMPLE_SIZE_FOR_TRUST,
      sampleSizeNote: closedTrades.length < MIN_SAMPLE_SIZE_FOR_TRUST
        ? `INSUFFICIENT SAMPLE SIZE: only ${closedTrades.length} closed trades - Sharpe/win-rate/profit-factor are not statistically meaningful below ${MIN_SAMPLE_SIZE_FOR_TRUST}.`
        : null,
    };
  }
}

export const backtestEngine = new BacktestEngine();
