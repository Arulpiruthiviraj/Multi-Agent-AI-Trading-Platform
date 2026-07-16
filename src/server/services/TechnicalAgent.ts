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

    if (Math.random() < 0.2) {
       eventBus.emitCalculation(traceId, 'TechnicalEngine', symbol, { rsi, sma20, sma50, currentPrice, macd: macd.macd, bbUpper: bb.upper, bbLower: bb.lower });
    }

    // Momentum Breakout
    if (currentPrice > sma20 && sma20 > sma50 && rsi > 50 && rsi < 70 && macd.macd > macd.signal) {
      if (Math.random() < 0.1) {
        eventBus.emitTradeIdea({
          traceId,
          symbol,
          side: "BUY",
          confidence: 0.85,
          reasoning: `Strong upward trend detected. MACD bullish crossover. RSI at ${rsi.toFixed(2)}.`,
          agent: "TechnicalAgent"
        });
      }
    }

    // Mean Reversion
    if (rsi < 30 && currentPrice < bb.lower) {
      if (Math.random() < 0.1) {
        eventBus.emitTradeIdea({
          traceId,
          symbol,
          side: "BUY",
          confidence: 0.78,
          reasoning: `Oversold condition. Price breached lower Bollinger Band with RSI at ${rsi.toFixed(2)}.`,
          agent: "TechnicalAgent"
        });
      }
    }
    
    // Overbought condition
    if (rsi > 75 && currentPrice > bb.upper) {
      if (Math.random() < 0.1) {
        eventBus.emitTradeIdea({
          traceId,
          symbol,
          side: "SELL",
          confidence: 0.88,
          reasoning: `Overbought condition. Price exceeded upper Bollinger Band. RSI at ${rsi.toFixed(2)}.`,
          agent: "TechnicalAgent"
        });
      }
    }
  }
}

export const technicalAgent = new TechnicalProposerAgent();
