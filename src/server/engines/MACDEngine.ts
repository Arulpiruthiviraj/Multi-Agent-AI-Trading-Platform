/**
 * ==========================================================
 * Module:
 * MACDEngine.ts
 *
 * Purpose:
 * Core implementation and logic for the MACDEngine.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for MACDEngine
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

export class MACDEngine {
  private shortPeriod: number;
  private longPeriod: number;
  private signalPeriod: number;

  constructor(shortPeriod: number = 12, longPeriod: number = 26, signalPeriod: number = 9) {
    this.shortPeriod = shortPeriod;
    this.longPeriod = longPeriod;
    this.signalPeriod = signalPeriod;
  }

  private calcEMA(prices: number[], period: number): number[] {
    if (prices.length === 0) return [];
    
    const emas: number[] = [];
    const multiplier = 2 / (period + 1);
    
    // Initial SMA for the first element
    let ema = prices[0];
    emas.push(ema);
    
    for (let i = 1; i < prices.length; i++) {
       ema = (prices[i] - emas[i-1]) * multiplier + emas[i-1];
       emas.push(ema);
    }
    return emas;
  }

  public calculate(prices: number[]): { macd: number, signal: number, histogram: number } {
    if (prices.length < this.longPeriod) {
      return { macd: 0, signal: 0, histogram: 0 };
    }

    const shortEma = this.calcEMA(prices, this.shortPeriod);
    const longEma = this.calcEMA(prices, this.longPeriod);
    
    const macdLines: number[] = [];
    for (let i = 0; i < prices.length; i++) {
       macdLines.push(shortEma[i] - longEma[i]);
    }
    
    const signalLines = this.calcEMA(macdLines, this.signalPeriod);
    
    const currentMacd = macdLines[macdLines.length - 1];
    const currentSignal = signalLines[signalLines.length - 1];
    const histogram = currentMacd - currentSignal;
    
    return {
       macd: currentMacd,
       signal: currentSignal,
       histogram: histogram
    };
  }
}

export const macdEngine = new MACDEngine(12, 26, 9);
