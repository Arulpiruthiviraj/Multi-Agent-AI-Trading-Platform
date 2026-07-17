export class TechnicalIndicators {
  public static calculateSMA(prices: number[], period: number): number {
    if (prices.length < period) return prices[prices.length - 1] || 0;
    const slice = prices.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  }

  public static calculateEMA(prices: number[], period: number): number {
    if (prices.length < period) return prices[prices.length - 1] || 0;
    let ema = this.calculateSMA(prices.slice(0, period), period);
    const multiplier = 2 / (period + 1);
    for (let i = period; i < prices.length; i++) {
      ema = (prices[i] - ema) * multiplier + ema;
    }
    return ema;
  }

  public static calculateATR(highs: number[], lows: number[], closes: number[], period: number = 14): number {
    if (closes.length < period + 1) return 0;
    const trs = [];
    for (let i = 1; i < closes.length; i++) {
      const hl = highs[i] - lows[i];
      const hc = Math.abs(highs[i] - closes[i - 1]);
      const lc = Math.abs(lows[i] - closes[i - 1]);
      trs.push(Math.max(hl, hc, lc));
    }
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trs.length; i++) {
      atr = ((atr * (period - 1)) + trs[i]) / period; // Wilder's smoothing
    }
    return atr;
  }

  public static calculateBollingerBands(prices: number[], period: number = 20, stdDev: number = 2) {
    if (prices.length < period) return { middle: prices[prices.length-1]||0, upper: prices[prices.length-1]||0, lower: prices[prices.length-1]||0 };
    const sma = this.calculateSMA(prices, period);
    const slice = prices.slice(-period);
    const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
    const sd = Math.sqrt(variance);
    return {
      middle: sma,
      upper: sma + (sd * stdDev),
      lower: sma - (sd * stdDev)
    };
  }

  public static calculateVWAP(prices: number[], volumes: number[]): number {
    if (prices.length === 0) return 0;
    let sumPV = 0;
    let sumV = 0;
    for (let i = 0; i < prices.length; i++) {
      sumPV += prices[i] * volumes[i];
      sumV += volumes[i];
    }
    return sumV === 0 ? prices[prices.length - 1] : sumPV / sumV;
  }

  public static calculateADX(highs: number[], lows: number[], closes: number[], period: number = 14): number {
    if (closes.length < period * 2) return 50;
    let plusDM = [], minusDM = [];
    for (let i = 1; i < highs.length; i++) {
      const upMove = highs[i] - highs[i - 1];
      const downMove = lows[i - 1] - lows[i];
      if (upMove > downMove && upMove > 0) {
        plusDM.push(upMove);
        minusDM.push(0);
      } else if (downMove > upMove && downMove > 0) {
        plusDM.push(0);
        minusDM.push(downMove);
      } else {
        plusDM.push(0);
        minusDM.push(0);
      }
    }
    const atr = this.calculateATR(highs, lows, closes, period);
    if (atr === 0) return 50;
    let smoothPlusDM = plusDM.slice(0, period).reduce((a,b)=>a+b, 0);
    let smoothMinusDM = minusDM.slice(0, period).reduce((a,b)=>a+b, 0);
    for (let i = period; i < plusDM.length; i++) {
       smoothPlusDM = smoothPlusDM - (smoothPlusDM / period) + plusDM[i];
       smoothMinusDM = smoothMinusDM - (smoothMinusDM / period) + minusDM[i];
    }
    const plusDI = 100 * (smoothPlusDM / atr);
    const minusDI = 100 * (smoothMinusDM / atr);
    const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI + 0.0001) * 100;
    return dx;
  }

  public static calculateStochastic(highs: number[], lows: number[], closes: number[], period: number = 14): number {
     if (closes.length < period) return 50;
     const currentClose = closes[closes.length - 1];
     const highestHigh = Math.max(...highs.slice(-period));
     const lowestLow = Math.min(...lows.slice(-period));
     if (highestHigh === lowestLow) return 50;
     return ((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100;
  }
  
  public static calculateOBV(closes: number[], volumes: number[]): number {
    if (closes.length === 0) return 0;
    let obv = 0;
    for (let i = 1; i < closes.length; i++) {
      if (closes[i] > closes[i - 1]) obv += volumes[i];
      else if (closes[i] < closes[i - 1]) obv -= volumes[i];
    }
    return obv;
  }

  public static calculateMFI(highs: number[], lows: number[], closes: number[], volumes: number[], period: number = 14): number {
     if (closes.length < period + 1) return 50;
     let positiveMoneyFlow = 0;
     let negativeMoneyFlow = 0;
     for (let i = closes.length - period; i < closes.length; i++) {
         const typicalPrice = (highs[i] + lows[i] + closes[i]) / 3;
         const prevTypicalPrice = (highs[i-1] + lows[i-1] + closes[i-1]) / 3;
         const moneyFlow = typicalPrice * volumes[i];
         if (typicalPrice > prevTypicalPrice) positiveMoneyFlow += moneyFlow;
         else if (typicalPrice < prevTypicalPrice) negativeMoneyFlow += moneyFlow;
     }
     if (negativeMoneyFlow === 0) return 100;
     const moneyRatio = positiveMoneyFlow / negativeMoneyFlow;
     return 100 - (100 / (1 + moneyRatio));
  }

  public static calculateIchimoku(highs: number[], lows: number[], closes: number[]): any {
     const conversionPeriod = 9;
     const basePeriod = 26;
     const leadingSpanBPeriod = 52;
     
     if (highs.length < leadingSpanBPeriod) return null;
     
     const getMinMax = (sliceHighs: number[], sliceLows: number[]) => ({
         highest: Math.max(...sliceHighs),
         lowest: Math.min(...sliceLows)
     });

     const conversionMinMax = getMinMax(highs.slice(-conversionPeriod), lows.slice(-conversionPeriod));
     const tenkanSen = (conversionMinMax.highest + conversionMinMax.lowest) / 2;

     const baseMinMax = getMinMax(highs.slice(-basePeriod), lows.slice(-basePeriod));
     const kijunSen = (baseMinMax.highest + baseMinMax.lowest) / 2;

     const senkouSpanA = (tenkanSen + kijunSen) / 2;

     const spanBMinMax = getMinMax(highs.slice(-leadingSpanBPeriod), lows.slice(-leadingSpanBPeriod));
     const senkouSpanB = (spanBMinMax.highest + spanBMinMax.lowest) / 2;

     const chikouSpan = closes[closes.length - 1]; // Current price plotted 26 periods behind

     return { tenkanSen, kijunSen, senkouSpanA, senkouSpanB, chikouSpan };
  }

  public static calculateFibonacciRetracement(high: number, low: number): any {
     const diff = high - low;
     return {
         level0: low,
         level236: low + diff * 0.236,
         level382: low + diff * 0.382,
         level500: low + diff * 0.5,
         level618: low + diff * 0.618,
         level786: low + diff * 0.786,
         level100: high
     };
  }

  public static detectSupportResistance(closes: number[], period: number = 20): any {
     if (closes.length < period) return { support: closes[0]||0, resistance: closes[0]||0 };
     const slice = closes.slice(-period);
     return {
         support: Math.min(...slice),
         resistance: Math.max(...slice)
     };
  }
}
