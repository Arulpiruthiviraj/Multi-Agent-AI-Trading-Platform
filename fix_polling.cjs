const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const targetQuoteLogic = `    // Fetch real Alpaca quote if available and broker is Alpaca
    let px_base =
      portfolioState.positions.find((p) => p.symbol === symbol)?.currentPrice ||
      parseFloat((100 + Math.random() * 100).toFixed(2));
    let isRealPrice = false;

    if (
      broker.includes("Alpaca") &&
      process.env.ALPACA_API_KEY &&
      process.env.ALPACA_SECRET_KEY
    ) {
      try {
        const qRes = await fetch(
          \`https://\${alpacaDataBaseUrl}/v2/stocks/quotes/latest?symbols=\${symbol}\`,
          {
            headers: {
              "APCA-API-KEY-ID": process.env.ALPACA_API_KEY,
              "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY,
            },
          },
        );
        if (qRes.ok) {
          const qData = await qRes.json();
          if (qData.quotes && qData.quotes[symbol]) {
            px_base = qData.quotes[symbol].bp; // Bid price baseline
            isRealPrice = true;`;

const newQuoteLogic = `    // Fetch real Alpaca quote if available and broker is Alpaca
    let px_base =
      portfolioState.positions.find((p) => p.symbol === symbol)?.currentPrice ||
      parseFloat((100 + Math.random() * 100).toFixed(2));
    let isRealPrice = false;

    if (
      broker.includes("Alpaca") &&
      process.env.ALPACA_API_KEY &&
      process.env.ALPACA_SECRET_KEY
    ) {
      // Prioritize WebSocket live quotes
      if (liveQuotes[symbol] && liveQuotes[symbol].price > 0) {
        px_base = liveQuotes[symbol].bid || liveQuotes[symbol].price;
        isRealPrice = true;
      } else {
        try {
          const qRes = await fetch(
            \`https://\${alpacaDataBaseUrl}/v2/stocks/quotes/latest?symbols=\${symbol}\`,
            {
              headers: {
                "APCA-API-KEY-ID": process.env.ALPACA_API_KEY,
                "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY,
              },
            },
          );
          if (qRes.ok) {
            const qData = await qRes.json();
            if (qData.quotes && qData.quotes[symbol]) {
              px_base = qData.quotes[symbol].bp; // Bid price baseline
              isRealPrice = true;`;

if (code.includes(targetQuoteLogic)) {
  code = code.replace(targetQuoteLogic, newQuoteLogic);
  
  // Close the extra block brace
  code = code.replace(
`            px_base = qData.quotes[symbol].bp; // Bid price baseline
            isRealPrice = true;
          }
        }
      } catch (e) {
        console.error("Failed to fetch real quote", e);
      }
    }`, 
`            px_base = qData.quotes[symbol].bp; // Bid price baseline
            isRealPrice = true;
          }
        }
      } catch (e) {
        console.error("Failed to fetch real quote", e);
      }
      } // Close the else block
    }`
  );
  
  fs.writeFileSync('server.ts', code);
  console.log("Polling refactored.");
} else {
  console.log("Could not find quote logic to replace");
}
