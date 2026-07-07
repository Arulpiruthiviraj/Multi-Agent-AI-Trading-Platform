const prices = [];
const length = 90;
const base = 150;
const currentPrice = 150;
const textSeed = 4;
for (let i = 0; i < length; i++) {
  if (i === length - 1) {
    prices.push(currentPrice);
  } else {
    const progress = i / (length - 1);
    const wave1 = Math.sin((i + textSeed) * 0.45) * 0.035;
    const wave2 = Math.cos(i * 0.25) * 0.02;
    const trend = (currentPrice - (base * 0.95)) * progress;
    const priceValue = (base * 0.95) + trend + (wave1 + wave2) * base;
    prices.push(parseFloat(Math.max(0.01, priceValue).toFixed(2)));
  }
}

// Old RSI
const oldRsis = [];
for (let idx = 20; idx < length; idx++) {
  let gains = 0;
  let losses = 0;
  for (let offset = 1; offset <= 14; offset++) {
    const change = prices[idx - 14 + offset] - prices[idx - 14 + offset - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / 14;
  const avgLoss = losses / 14;
  let rsi = 50;
  if (avgLoss === 0) rsi = 100;
  else if (avgGain === 0) rsi = 0;
  else {
    const rs = avgGain / avgLoss;
    rsi = 100 - (100 / (1 + rs));
  }
  oldRsis.push(rsi);
}
console.log("Old RSI latest:", oldRsis[oldRsis.length - 1]);

// New Wilder RSI
const rsiArr = [];
let avgGain = 0;
let avgLoss = 0;

for (let i = 1; i < length; i++) {
  const change = prices[i] - prices[i - 1];
  const gain = change > 0 ? change : 0;
  const loss = change < 0 ? -change : 0;
  
  if (i <= 14) {
    avgGain += gain;
    avgLoss += loss;
    if (i === 14) {
      avgGain /= 14;
      avgLoss /= 14;
      
      let rsi = 50;
      if (avgLoss === 0) rsi = 100;
      else if (avgGain === 0) rsi = 0;
      else rsi = 100 - (100 / (1 + (avgGain / avgLoss)));
      rsiArr.push({i, rsi});
    }
  } else {
    avgGain = ((avgGain * 13) + gain) / 14;
    avgLoss = ((avgLoss * 13) + loss) / 14;
    
    let rsi = 50;
    if (avgLoss === 0) rsi = 100;
    else if (avgGain === 0) rsi = 0;
    else rsi = 100 - (100 / (1 + (avgGain / avgLoss)));
    rsiArr.push({i, rsi});
  }
}
console.log("New RSI latest:", rsiArr[rsiArr.length - 1].rsi);
