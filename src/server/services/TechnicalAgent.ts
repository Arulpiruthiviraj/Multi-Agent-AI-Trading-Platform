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
import { rsiEngine } from '../engines/RSIEngine';
import { macdEngine } from '../engines/MACDEngine';

export class TechnicalProposerAgent {
  private priceHistory: Record<string, number[]> = {};

  constructor() {
    eventBus.on('MARKET_DATA', (data) => this.analyzeTick(data));
  }

  analyzeTick(data: { symbol: string, price: number, volume: number, timestamp: string }) {
    if (!this.priceHistory[data.symbol]) {
      this.priceHistory[data.symbol] = [];
    }
    const history = this.priceHistory[data.symbol];
    history.push(data.price);
    
    if (history.length > 50) {
      history.shift();
    }
    
    if (history.length === 50) {
      this.checkStrategies(data.symbol, history);
    }
  }

  private calcSMA(prices: number[], period: number) {
    if (prices.length < period) return prices[prices.length - 1];
    const slice = prices.slice(prices.length - period);
    return slice.reduce((a, b) => a + b, 0) / period;
  }
  
  private calcBollingerBands(prices: number[], period: number = 20) {
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
    
    const sma20 = this.calcSMA(prices, 20);
    const sma50 = this.calcSMA(prices, 50);
    const rsi = rsiEngine.calculate(prices);
    const macd = macdEngine.calculate(prices);
    const bb = this.calcBollingerBands(prices, 20);
    const traceId = Math.random().toString(36).substring(7);

    eventBus.emitCalculation(traceId, 'TechnicalEngine', symbol, { rsi, sma20, sma50, currentPrice, macd: macd.macd, bbUpper: bb.upper, bbLower: bb.lower });

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
        agent: "TechnicalAgent"
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
        agent: "TechnicalAgent"
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
        agent: "TechnicalAgent"
      });
    }
  }
}

export const technicalAgent = new TechnicalProposerAgent();
