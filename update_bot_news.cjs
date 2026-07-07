const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const targetStr = `              const mReq = await generateContentWithRetry(ai, {
                  model: "gemini-3.5-flash",
                  contents: \`You are a Macro Deep Research Agent. Provide a quick sentiment analysis of \${targetSymbol} within current market conditions. Output strict JSON: { "sentiment": "BULLISH" | "BEARISH" | "NEUTRAL", "score": number (-1 to 1), "thinking": "Internal thought process of market analysis in 1 sentence" }\`,
                  config: { responseMimeType: "application/json" }
              });`;

const replaceStr = `              let recentNewsContext = "";
              if (liveNews[targetSymbol] && liveNews[targetSymbol].length > 0) {
                 const headlines = liveNews[targetSymbol].map((n: any) => n.headline).join("; ");
                 recentNewsContext = \`Recent breaking news for \${targetSymbol}: \${headlines}.\`;
                 autoBotState.history.unshift({ time: new Date().toISOString(), type: 'scan', msg: \`[News Integration] Found live WebSocket news for \${targetSymbol}: \${liveNews[targetSymbol].length} recent headlines.\` });
              }

              const mReq = await generateContentWithRetry(ai, {
                  model: "gemini-3.5-flash",
                  contents: \`You are a Macro Deep Research Agent. Provide a quick sentiment analysis of \${targetSymbol} within current market conditions. \${recentNewsContext} Output strict JSON: { "sentiment": "BULLISH" | "BEARISH" | "NEUTRAL", "score": number (-1 to 1), "thinking": "Internal thought process of market analysis in 1 sentence" }\`,
                  config: { responseMimeType: "application/json" }
              });`;

if (code.includes(targetStr)) {
  code = code.replace(targetStr, replaceStr);
  fs.writeFileSync('server.ts', code);
  console.log("Bot loop updated with live news.");
} else {
  console.log("Could not find the target string.");
}
