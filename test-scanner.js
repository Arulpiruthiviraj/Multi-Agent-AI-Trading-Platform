const getMockPrices = (symbol, currentPrice, base, length = 40) => {
  const prices = [];
  const textSeed = symbol.charCodeAt(0) + (symbol.charCodeAt(1) || 0);
  for (let i = 0; i < length; i++) {
    if (i === length - 1) {
      prices.push(currentPrice);
    } else {
      const progress = i / (length - 1);
      const wave1 = Math.sin((i + textSeed) * 0.45) * 0.035;
      const wave2 = Math.cos(i * 0.25) * 0.02;
      const trend = (currentPrice - (base * 0.95)) * progress;
      let priceValue = (base * 0.95) + trend + (wave1 + wave2) * base;
      
      // Inject some volatility based on symbol length to make RSI move around
      if (symbol.length === 3) priceValue *= 0.8; // Oversold?
      if (symbol.length === 4 && symbol[0] === 'N') priceValue *= 1.2; // Overbought?

      prices.push(parseFloat(Math.max(0.01, priceValue).toFixed(2)));
    }
  }
  return prices;
};

const calculateWildersRSI = (prices) => {
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (i <= 14) {
      avgGain += gain;
      avgLoss += loss;
      if (i === 14) {
        avgGain /= 14;
        avgLoss /= 14;
      }
    } else {
      avgGain = ((avgGain * 13) + gain) / 14;
      avgLoss = ((avgLoss * 13) + loss) / 14;
    }
  }
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - (100 / (1 + (avgGain / avgLoss)));
};

const scannerBasePrices = {
  AAPL: 175.20, MSFT: 415.50, NVDA: 875.12, AMD: 170.45,
  SPY: 510.30, GLD: 215.10, TLT: 94.60, TSLA: 178.40, BTC: 64250.00
};

for (const [sym, price] of Object.entries(scannerBasePrices)) {
  const rsi = calculateWildersRSI(getMockPrices(sym, price, price));
  console.log(sym, rsi);
}
