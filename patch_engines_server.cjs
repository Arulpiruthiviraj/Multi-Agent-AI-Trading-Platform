const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const expandedEngines = `    engines: {
      marketIntelligence: { vwap: 150.2, rvol: 1.4, gap: 0.5 },
      trend: { ema200: "Above", superTrend: "Buy", adx: 28, strength: 89 },
      momentum: { rsi: 64, macd: "Bullish Cross", cci: 110, score: 84 },
      volume: { obv: "Rising", cmf: 0.15, delta: "+450k", score: 91 },
      volatility: { atr: 4.8, bollinger: "Upper Band", regime: "Expanding" },
      marketStructure: { structure: "Higher Highs", choch: false, liquiditySweep: "None" },
      smartMoney: { orderBlock: "Bullish 4H", fvg: "Filled", premiumDiscount: "Discount" },
      candlestick: { pattern: "Bullish Engulfing", reliability: "High" },
      optionsFlow: { putCallRatio: 0.65, gammaExposure: "+1.2B", maxPain: 320 },
      news: { sentiment: 85, impact: "High", sources: 14 },
      macro: { cpi: "Inline", yields: "Falling", dollarIndex: "Weak", score: 72 },
      historical: { matches: 842, winRate: 72, avgReturn: 6.4 },
      evidenceTable: [
         { criteria: "Price > 200 EMA", result: "Bullish", weight: 12 },
         { criteria: "MACD bullish crossover", result: "Bullish", weight: 8 },
         { criteria: "Relative volume 2.4x average", result: "Bullish", weight: 10 },
         { criteria: "RSI overbought (78)", result: "Bearish", weight: -6 },
         { criteria: "Positive earnings surprise", result: "Bullish", weight: 9 },
         { criteria: "Recent negative macro news", result: "Bearish", weight: -4 }
      ],
      verification: { aiConfidence: 86, engineConfidence: 88, agreement: 97 }
    },`;

code = code.replace(/engines: \{[\s\S]*?verification: \{ aiConfidence: 86, engineConfidence: 88, agreement: 97 \}\n    \},/, expandedEngines);

const extendedMutation = `           // Mutate Intelligence Engines
           try {
              if (autoBotState.engines) {
                 autoBotState.engines.marketIntelligence.vwap += (Math.random() - 0.5) * 2;
                 autoBotState.engines.marketIntelligence.rvol = Math.max(0.1, autoBotState.engines.marketIntelligence.rvol + (Math.random() - 0.5) * 0.2);
                 autoBotState.engines.trend.strength = Math.max(0, Math.min(100, autoBotState.engines.trend.strength + (Math.random() - 0.5) * 5));
                 autoBotState.engines.momentum.rsi = Math.max(0, Math.min(100, autoBotState.engines.momentum.rsi + (Math.random() - 0.5) * 4));
                 autoBotState.engines.news.sentiment = Math.max(0, Math.min(100, autoBotState.engines.news.sentiment + (Math.random() - 0.5) * 10));
                 autoBotState.engines.verification.aiConfidence = Math.max(50, Math.min(99, autoBotState.engines.verification.aiConfidence + Math.floor((Math.random() - 0.5) * 5)));
                 autoBotState.engines.verification.engineConfidence = Math.max(50, Math.min(99, autoBotState.engines.verification.engineConfidence + Math.floor((Math.random() - 0.5) * 5)));
                 autoBotState.engines.verification.agreement = 100 - Math.abs(autoBotState.engines.verification.aiConfidence - autoBotState.engines.verification.engineConfidence);
              }
           } catch(e) {}`;

code = code.replace(/           \/\/ Mutate Intelligence Engines[\s\S]*?\} catch\(e\) \{\}/, extendedMutation);

fs.writeFileSync('server.ts', code);
console.log("Patched server.ts with expanded engines");
