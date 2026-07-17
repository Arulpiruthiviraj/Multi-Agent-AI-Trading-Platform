import { eventBus } from '../core/EventBus';
import { TechnicalIndicators } from './TechnicalIndicators';

export class AdvancedQuantEngines {
  private priceHistory: Record<string, { high: number[], low: number[], close: number[], volume: number[] }> = {};

  public start() {
    eventBus.on('MARKET_DATA', (data) => {
       this.processMarketData(data);
    });
  }

  private processMarketData(data: any) {
    const symbol = data.symbol;
    if (!this.priceHistory[symbol]) {
      this.priceHistory[symbol] = { high: [], low: [], close: [], volume: [] };
    }
    const history = this.priceHistory[symbol];
    
    // Create a mock high/low based on the tick data to support full indicators
    const mockHigh = data.price * (1 + (Math.random() * 0.002));
    const mockLow = data.price * (1 - (Math.random() * 0.002));
    
    history.high.push(mockHigh);
    history.low.push(mockLow);
    history.close.push(data.price);
    history.volume.push(data.volume);

    // Keep last 100 periods
    if (history.close.length > 100) {
      history.high.shift();
      history.low.shift();
      history.close.shift();
      history.volume.shift();
    }

    if (history.close.length >= 14 && Math.random() < 0.2) {
       this.runAllEngines(symbol, history);
    }
  }

  private runAllEngines(symbol: string, history: any) {
     const traceId = Math.random().toString(36).substring(7);
     
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
     
     // Output quantitative signals
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
