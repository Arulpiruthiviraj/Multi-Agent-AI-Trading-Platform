const fs = require('fs');

const code = `/**
 * ==========================================================
 * Module: AdvancedQuantEngines.ts
 *
 * Purpose:
 * Evaluates technical signals based on real OHLCV data.
 * ==========================================================
 */
import { eventBus } from '../core/EventBus';
import { TechnicalIndicators } from './TechnicalIndicators';
import crypto from 'crypto';

export class AdvancedQuantEngines {
  private priceHistory: Record<string, { high: number[], low: number[], close: number[], volume: number[] }> = {};
  private tickCount: Record<string, number> = {};

  public start() {
    eventBus.on('MARKET_DATA', (data) => {
       this.processMarketData(data);
    });
  }

  private processMarketData(data: any) {
    const symbol = data.symbol;
    if (!this.priceHistory[symbol]) {
      this.priceHistory[symbol] = { high: [], low: [], close: [], volume: [] };
      this.tickCount[symbol] = 0;
    }
    const history = this.priceHistory[symbol];
    
    // For tick data, without formal aggregation, we'll use the price itself as H/L/C 
    // to avoid fabricating synthetic volatility.
    // A production system should use formal 1m/5m/15m OHLC candles.
    history.high.push(data.price);
    history.low.push(data.price);
    history.close.push(data.price);
    history.volume.push(data.volume || 0);

    this.tickCount[symbol]++;

    if (history.close.length > 100) {
      history.high.shift();
      history.low.shift();
      history.close.shift();
      history.volume.shift();
    }

    // Run engines every 5 ticks instead of randomly
    if (history.close.length >= 14 && this.tickCount[symbol] % 5 === 0) {
       this.runAllEngines(symbol, history);
    }
  }

  private runAllEngines(symbol: string, history: any) {
     const traceId = crypto.randomUUID();
     
     const atr = TechnicalIndicators.calculateATR(history.high, history.low, history.close, 14);
     const adx = TechnicalIndicators.calculateADX(history.high, history.low, history.close, 14);
     const vwap = TechnicalIndicators.calculateVWAP(history.close, history.volume);
     const obv = TechnicalIndicators.calculateOBV(history.close, history.volume);
     const mfi = TechnicalIndicators.calculateMFI(history.high, history.low, history.close, history.volume, 14);
     const stoch = TechnicalIndicators.calculateStochastic(history.high, history.low, history.close, 14);
     const sr = TechnicalIndicators.detectSupportResistance(history.close, 20);
     const bb = TechnicalIndicators.calculateBollingerBands(history.close, 20);
     
     const currentPrice = history.close[history.close.length - 1];
     const trend = currentPrice > vwap && adx > 25 ? 'UPTREND' : currentPrice < vwap && adx > 25 ? 'DOWNTREND' : 'CHOPPY';
     
     eventBus.emitCalculation(traceId, 'AdvancedQuantEngine', symbol, {
        atr: atr.toFixed(4),
        adx: adx.toFixed(2),
        vwap: vwap.toFixed(2),
        obv: obv.toFixed(0),
        mfi: mfi.toFixed(2),
        stochastic: stoch.toFixed(2),
        support: sr.support.toFixed(2),
        resistance: sr.resistance.toFixed(2),
        trend
     });
  }
}

export const advancedQuantEngines = new AdvancedQuantEngines();
`;

fs.writeFileSync('src/server/engines/AdvancedQuantEngines.ts', code);
console.log("Patched AdvancedQuantEngines.ts");
