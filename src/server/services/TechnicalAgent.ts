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
      eventBus.emitTradeIdea({
        traceId,
        symbol,
        side: "BUY",
        confidence: 0.85,
        currentPrice,
        reasoning: `Strong upward trend detected. MACD bullish crossover. RSI at ${rsi.toFixed(2)}.`,
        agent: "TechnicalAgent"
      });
    }

    // Mean Reversion
    if (rsi < 30 && currentPrice < bb.lower) {
      eventBus.emitTradeIdea({
        traceId,
        symbol,
        side: "BUY",
        confidence: 0.78,
        currentPrice,
        reasoning: `Oversold condition. Price breached lower Bollinger Band with RSI at ${rsi.toFixed(2)}.`,
        agent: "TechnicalAgent"
      });
    }
    
    // Overbought condition
    if (rsi > 75 && currentPrice > bb.upper) {
      eventBus.emitTradeIdea({
        traceId,
        symbol,
        side: "SELL",
        confidence: 0.88,
        currentPrice,
        reasoning: `Overbought condition. Price exceeded upper Bollinger Band. RSI at ${rsi.toFixed(2)}.`,
        agent: "TechnicalAgent"
      });
    }
  }
}

export const technicalAgent = new TechnicalProposerAgent();
