/**
 * ==========================================================
 * Module:
 * TechnicalAgent.ts
 *
 * Purpose:
 * Core implementation and logic for the TechnicalAgent.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for TechnicalAgent
 * - Interface with backend APIs and EventBus
 * - Render UI components (if React)
 *
 * Inputs:
 * - Module dependencies and injected props
 *
 * Outputs:
 * - Formatted data or React Elements
 *
 * Emits:
 * - Relevant system events
 *
 * Dependencies:
 * - Standard Argus architecture layers
 *
 * Called By:
 * - Argus Routing / Parent Components
 *
 * Never:
 * - Mutate global state directly without EventBus
 * - Call AI providers directly (Must use AIRouter)
 *
 * ==========================================================
 */

import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';
import { isPipelineAgentEnabled } from '../core/pipelineAgentGate';
import { rsiEngine } from '../engines/RSIEngine';
import { macdEngine } from '../engines/MACDEngine';
import { quantThresholds } from '../config/quantThresholds';
import { generateTraceId } from '../core/traceId';

export class TechnicalProposerAgent {
  // Tick-driven via MARKET_DATA (MarketDataWorker WebSocket), not a standalone 60s timer.
  // Requires quantThresholds.technicalHistoryBars ticks before checkStrategies fires.
  private priceHistory: Record<string, number[]> = {};
  private listening = false;
  private readonly onMarketData = (data: { symbol: string, price: number, volume: number, timestamp: string }) => this.analyzeTick(data);

  start() {
    if (this.listening) return;
    eventBus.subscribe('MARKET_DATA', this.onMarketData);
    this.listening = true;
  }

  stop() {
    if (!this.listening) return;
    eventBus.unsubscribe('MARKET_DATA', this.onMarketData);
    this.listening = false;
  }

  analyzeTick(data: { symbol: string, price: number, volume: number, timestamp: string }) {
    if (!isLiveIdeaGenerationEnabled()) return;
    if (!isPipelineAgentEnabled('TechnicalAgent')) return;

    if (!this.priceHistory[data.symbol]) {
      this.priceHistory[data.symbol] = [];
    }
    const history = this.priceHistory[data.symbol];
    history.push(data.price);
    
    if (history.length > quantThresholds.technicalHistoryBars) {
      history.shift();
    }

    if (history.length === quantThresholds.technicalHistoryBars) {
      this.checkStrategies(data.symbol, history);
    }
  }

  private calcSMA(prices: number[], period: number) {
    if (prices.length < period) return prices[prices.length - 1];
    const slice = prices.slice(prices.length - period);
    return slice.reduce((a, b) => a + b, 0) / period;
  }
  
  private calcBollingerBands(prices: number[], period: number = quantThresholds.bollingerPeriod) {
     const sma = this.calcSMA(prices, period);
     const slice = prices.slice(prices.length - period);
     let sumSq = 0;
     for(let p of slice) {
         sumSq += Math.pow(p - sma, 2);
     }
     const stdDev = Math.sqrt(sumSq / period);
     return { upper: sma + (stdDev * 2), lower: sma - (stdDev * 2) };
  }

  private clamp01(v: number): number {
    return Math.max(0, Math.min(1, v));
  }

  // Maps a 0-1 signal-strength score to a confidence in [0.55, 0.95] - a fired rule always has
  // some baseline validity (it wouldn't have fired otherwise), and the strength score scales how
  // far into "textbook" territory the actual indicator values are, rather than a fixed constant
  // that doesn't distinguish a barely-triggered signal from an extreme one.
  private strengthToConfidence(strength01: number): number {
    return Number((0.55 + 0.40 * this.clamp01(strength01)).toFixed(3));
  }

  private checkStrategies(symbol: string, prices: number[]) {
    const currentPrice = prices[prices.length - 1];
    const traceId = generateTraceId(symbol);
    const startedAt = Date.now();

    // Real STARTED/COMPLETED bracket for live animation (previously only Kronos had one) -
    // TechnicalAgent's computation is synchronous and fast, but the pair still lets the UI show
    // exactly when this node began working versus when it produced a real result.
    eventBus.emit(EVENTS.TECHNICAL_ANALYSIS_STARTED, { traceId, symbol, timestamp: new Date(startedAt).toISOString() });

    const sma20 = this.calcSMA(prices, quantThresholds.bollingerPeriod);
    const sma50 = this.calcSMA(prices, 50);
    const rsi = rsiEngine.calculate(prices);
    const macd = macdEngine.calculate(prices);
    const bb = this.calcBollingerBands(prices, 20);

    eventBus.emitCalculation(traceId, 'TechnicalEngine', symbol, { rsi, sma20, sma50, currentPrice, macd: macd.macd, bbUpper: bb.upper, bbLower: bb.lower });
    eventBus.emit(EVENTS.TECHNICAL_ANALYSIS_COMPLETED, { traceId, symbol, latencyMs: Date.now() - startedAt, rsi, sma20, sma50, currentPrice, macd: macd.macd, bbUpper: bb.upper, bbLower: bb.lower });

    // Momentum Breakout
    if (currentPrice > sma20 && sma20 > sma50 && rsi > 50 && rsi < 70 && macd.macd > macd.signal) {
      const rsiStrength = this.clamp01((rsi - 50) / 20);
      const macdStrength = this.clamp01((macd.macd - macd.signal) / (currentPrice * 0.005));
      const trendStrength = this.clamp01((sma20 - sma50) / (currentPrice * 0.02));
      const confidence = this.strengthToConfidence((rsiStrength + macdStrength + trendStrength) / 3);
      eventBus.emitTradeIdea({
        traceId,
        symbol,
        side: "BUY",
        confidence,
        currentPrice,
        reasoning: `Strong upward trend detected. MACD bullish crossover. RSI at ${rsi.toFixed(2)}.`,
        agent: "TechnicalAgent",
        latencyMs: Date.now() - startedAt,
        indicatorsSnapshot: { rsi, sma20, sma50, macd: macd.macd, macdSignal: macd.signal, bbUpper: bb.upper, bbLower: bb.lower },
      });
    }

    // Mean Reversion
    if (rsi < 30 && currentPrice < bb.lower) {
      const rsiStrength = this.clamp01((30 - rsi) / 30);
      const bandWidth = bb.upper - bb.lower;
      const bbStrength = bandWidth > 0 ? this.clamp01((bb.lower - currentPrice) / bandWidth) : 0;
      const confidence = this.strengthToConfidence((rsiStrength + bbStrength) / 2);
      eventBus.emitTradeIdea({
        traceId,
        symbol,
        side: "BUY",
        confidence,
        currentPrice,
        reasoning: `Oversold condition. Price breached lower Bollinger Band with RSI at ${rsi.toFixed(2)}.`,
        agent: "TechnicalAgent",
        latencyMs: Date.now() - startedAt,
        indicatorsSnapshot: { rsi, sma20, sma50, macd: macd.macd, bbUpper: bb.upper, bbLower: bb.lower },
      });
    }

    // Overbought condition
    if (rsi > 75 && currentPrice > bb.upper) {
      const rsiStrength = this.clamp01((rsi - 75) / 25);
      const bandWidth = bb.upper - bb.lower;
      const bbStrength = bandWidth > 0 ? this.clamp01((currentPrice - bb.upper) / bandWidth) : 0;
      const confidence = this.strengthToConfidence((rsiStrength + bbStrength) / 2);
      eventBus.emitTradeIdea({
        traceId,
        symbol,
        side: "SELL",
        confidence,
        currentPrice,
        reasoning: `Overbought condition. Price exceeded upper Bollinger Band. RSI at ${rsi.toFixed(2)}.`,
        agent: "TechnicalAgent",
        latencyMs: Date.now() - startedAt,
        indicatorsSnapshot: { rsi, sma20, sma50, macd: macd.macd, bbUpper: bb.upper, bbLower: bb.lower },
      });
    }
  }
}

export const technicalAgent = new TechnicalProposerAgent();
