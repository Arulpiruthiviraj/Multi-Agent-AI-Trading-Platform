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
 * strategy only - it does not re-run the live AI-agent consensus pipeline
 * (News/Fundamental/Macro/ChiefTrader) against historical data, since doing
 * that responsibly and affordably (point-in-time news/fundamentals data,
 * per-bar AI calls across a real date range) is materially more
 * infrastructure than this phase covers. That is future work, not
 * something this engine claims to do.
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
}

interface OpenPosition {
  symbol: string;
  quantity: number;
  entryPrice: number;
}

const LOOKBACK = 50;
const SPREAD_PCT = 0.0005; // matches InternalPaperBroker's real spread model
const PER_POSITION_SIZE_PCT = 0.10; // fixed 10% of initial cash per position, single-position-per-symbol
const PERIODS_PER_YEAR = 252; // assumes daily bars; only meaningful for timeframe='1Day'
const MIN_SAMPLE_SIZE_FOR_TRUST = 20;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
function strengthToConfidence(strength01: number): number {
  return Number((0.55 + 0.40 * clamp01(strength01)).toFixed(3));
}

export class BacktestEngine {
  async run(config: BacktestConfig): Promise<any> {
    const runId = crypto.randomUUID();
    const timeframe = config.timeframe || '1Day';
    const initialCash = config.initialCash || 100000;
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
      for (const symbol of config.symbols) {
        await historicalDataGateway.ensureBars(symbol, timeframe, startMs, endMs);
        const bars = await historicalDataGateway.getBars(symbol, timeframe, startMs, endMs);
        if (bars.length < LOOKBACK) {
          throw new Error(`Only ${bars.length} real bars available for ${symbol} in this range - need at least ${LOOKBACK} to evaluate the strategy's lookback window. Widen the date range.`);
        }
        barsBySymbol[symbol] = bars;
      }

      type TimelineEvent = { symbol: string; index: number; timestamp: number };
      const timeline: TimelineEvent[] = [];
      for (const symbol of config.symbols) {
        barsBySymbol[symbol].forEach((bar, index) => timeline.push({ symbol, index, timestamp: bar.timestamp }));
      }
      timeline.sort((a, b) => a.timestamp - b.timestamp);

      const clock = new ReplayClock(timeline[0].timestamp);
      let cash = initialCash;
      const positions: Record<string, OpenPosition> = {};
      const equityCurve: { timestamp: number; equity: number }[] = [];
      const tradeLog: SimulatedTrade[] = [];

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
          if (changePct <= -0.05) { signal = 'SELL'; confidence = 0.60; reasoning = 'Stop-loss (-5%)'; }
          else if (changePct >= 0.15) { signal = 'SELL'; confidence = 0.60; reasoning = 'Take-profit (+15%)'; }
        }

        if (signal === 'BUY' && confidence >= 0.55) {
          const targetDollar = Math.min(initialCash * PER_POSITION_SIZE_PCT, cash);
          const fillPrice = currentPrice * (1 + SPREAD_PCT);
          const qty = Math.floor(targetDollar / fillPrice);
          if (qty > 0) {
            cash -= qty * fillPrice;
            positions[evt.symbol] = { symbol: evt.symbol, quantity: qty, entryPrice: fillPrice };
            tradeLog.push({ symbol: evt.symbol, side: 'BUY', timestamp: evt.timestamp, price: fillPrice, quantity: qty, confidence, reasoning });
          }
        } else if (signal === 'SELL' && pos) {
          const fillPrice = currentPrice * (1 - SPREAD_PCT);
          const realizedPnl = Number(((fillPrice - pos.entryPrice) * pos.quantity).toFixed(2));
          cash += pos.quantity * fillPrice;
          delete positions[evt.symbol];
          tradeLog.push({ symbol: evt.symbol, side: 'SELL', timestamp: evt.timestamp, price: fillPrice, quantity: pos.quantity, confidence, reasoning, realizedPnl });
        }

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
        equityCurve.push({ timestamp: evt.timestamp, equity: Number((cash + posValue).toFixed(2)) });
      }

      // Liquidate any still-open positions at the last known real price for final accounting.
      for (const s of Object.keys(positions)) {
        const p = positions[s];
        const lastBar = barsBySymbol[s][barsBySymbol[s].length - 1];
        const fillPrice = lastBar.close * (1 - SPREAD_PCT);
        const realizedPnl = Number(((fillPrice - p.entryPrice) * p.quantity).toFixed(2));
        cash += p.quantity * fillPrice;
        tradeLog.push({ symbol: s, side: 'SELL', timestamp: lastBar.timestamp, price: fillPrice, quantity: p.quantity, confidence: 1, reasoning: 'End-of-backtest liquidation', realizedPnl });
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

      return { id: runId, status: 'COMPLETED', initialCash, finalEquity, totalReturnPct: metrics.totalReturnPct, ...metrics, trades: tradeLog.length, equityCurve, tradeLog };
    } catch (e: any) {
      await db.update(schema.backtestRuns).set({ status: 'FAILED', errorMessage: e.message }).where(eq(schema.backtestRuns.id, runId));
      throw e;
    }
  }

  async getRun(id: string) {
    const rows = await db.select().from(schema.backtestRuns).where(eq(schema.backtestRuns.id, id)).limit(1);
    return rows[0] || null;
  }

  async listRuns() {
    return db.select().from(schema.backtestRuns);
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
    const sharpe = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(PERIODS_PER_YEAR) : 0;
    const sortino = downsideStd > 0 ? (meanRet / downsideStd) * Math.sqrt(PERIODS_PER_YEAR) : 0;

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
