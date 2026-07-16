export class RSIEngine {
  private period: number;

  constructor(period: number = 14) {
    this.period = period;
  }

  /**
   * Calculates the Relative Strength Index (RSI) using Wilder's Smoothing.
   * @param prices Array of historical prices. The last element is the current price.
   * @returns The calculated RSI score (0-100).
   */
  public calculate(prices: number[]): number {
    if (prices.length <= this.period) return 50; // Default neutral score if insufficient data

    let avgGain = 0;
    let avgLoss = 0;

    // 1. Calculate the initial average gain and loss (SMA of first 'period' elements)
    for (let i = 1; i <= this.period; i++) {
      const diff = prices[i] - prices[i - 1];
      if (diff > 0) {
        avgGain += diff;
      } else {
        avgLoss += Math.abs(diff);
      }
    }
    
    avgGain /= this.period;
    avgLoss /= this.period;

    // 2. Apply Wilder's Smoothing for the remaining prices
    for (let i = this.period + 1; i < prices.length; i++) {
      const diff = prices[i] - prices[i - 1];
      let currentGain = 0;
      let currentLoss = 0;

      if (diff > 0) {
        currentGain = diff;
      } else {
        currentLoss = Math.abs(diff);
      }

      avgGain = ((avgGain * (this.period - 1)) + currentGain) / this.period;
      avgLoss = ((avgLoss * (this.period - 1)) + currentLoss) / this.period;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }
}

export const rsiEngine = new RSIEngine(14);
