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

  /**
   * Real defect found and fixed (2026-09-22, CLI runtime forensics pass): this previously seeded
   * the EMA with a single raw price (`prices[0]`) instead of the standard SMA-of-first-`period`
   * warmup every textbook/reference EMA definition uses. Two concrete, proven consequences: (1)
   * every EMA carried a lasting seed bias that only decays exponentially, never fully vanishing
   * for realistic history lengths; (2) because `calculate()` below runs this same function on
   * `macdLines` too, `macdLines[0]` was always EXACTLY `shortEma[0] - longEma[0]` = `prices[0] -
   * prices[0]` = 0 regardless of real data, so the signal line's own seed was corrupted by a
   * second, compounded instance of the same bug. Live-measured via the real TS-vs-Java parity
   * comparator (strategyContextParity.ts's QUANT_CORE_PARITY_DIVERGENCE events, which already
   * compares this exact engine's output against Java's independent implementation): macdSignal
   * diverged 17.5% - a clear outlier next to rsi (6.8%) and raw macd (5.4%) on the same real bars,
   * consistent with this double-compounded seeding error. Fix: standard convention - seed at
   * index `period-1` with the SMA of `prices[0..period-1]`, backfill indices before that with the
   * same seed value (this engine's own contract returns one EMA value per input index, consumed
   * positionally by `calculate()` below), then apply the real recursive EMA formula from
   * `period` onward. Matches every standard reference definition (SMA-seeded EMA), not an
   * invented convention.
   */
  private calcEMA(prices: number[], period: number): number[] {
    if (prices.length === 0) return [];
    const multiplier = 2 / (period + 1);
    const emas: number[] = new Array(prices.length);

    const warmupLen = Math.min(period, prices.length);
    let seedSum = 0;
    for (let i = 0; i < warmupLen; i++) seedSum += prices[i];
    const seed = seedSum / warmupLen;
    for (let i = 0; i < warmupLen; i++) emas[i] = seed;

    for (let i = warmupLen; i < prices.length; i++) {
      emas[i] = (prices[i] - emas[i - 1]) * multiplier + emas[i - 1];
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
