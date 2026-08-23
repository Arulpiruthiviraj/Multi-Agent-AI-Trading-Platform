import { RSIEngine } from '../src/server/engines/RSIEngine';
import { MACDEngine } from '../src/server/engines/MACDEngine';
import { calcSMA, calcBollingerBands } from '../src/server/services/technicalSignal';
import { TechnicalIndicators } from '../src/server/engines/TechnicalIndicators';

function risingTrend(n: number, start: number): number[] {
  const out: number[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p += (i % 3 === 2) ? -1.15 : 1.0;
    out.push(Number(p.toFixed(4)));
  }
  return out;
}

function oscillating(n: number, start: number): number[] {
  const out: number[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 3) * 2;
    out.push(Number(p.toFixed(4)));
  }
  return out;
}

const rsi = new RSIEngine(14);
const macd = new MACDEngine(12, 26, 9);

const fixtures = {
  risingTrend60: risingTrend(60, 100),
  oscillating60: oscillating(60, 100),
};

const results: Record<string, any> = {};
for (const [name, prices] of Object.entries(fixtures)) {
  const highs = prices.map((p) => p * 1.01);
  const lows = prices.map((p) => p * 0.99);
  results[name] = {
    prices,
    rsi14: rsi.calculate(prices),
    macd: macd.calculate(prices),
    sma20: calcSMA(prices, 20),
    bollinger20: calcBollingerBands(prices, 20),
    atr14: TechnicalIndicators.calculateATR(highs, lows, prices, 14),
  };
}

console.log(JSON.stringify(results, null, 2));
