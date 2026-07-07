const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const targetQuoteEndpoint = `  // Endpoint: Alpaca Integration - Real Market Quote
  app.get("/api/v1/alpaca/quote", async (req: Request, res: Response) => {
    const symbol = req.query.symbol as string;
    if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) {
      return res
        .status(400)
        .json({
          error: "Missing ALPACA_API_KEY or ALPACA_SECRET_KEY in Environment",
        });
    }
    try {
      const response = await fetch(
        \`https://data.alpaca.markets/v2/stocks/quotes/latest?symbols=\${symbol}\`,
        {
          headers: {
            "APCA-API-KEY-ID": process.env.ALPACA_API_KEY,
            "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY,
          },
        },
      );
      const data = await response.json();
      if (!response.ok) return res.status(response.status).json(data);
      res.json(data);
    } catch (e: any) {
      res
        .status(500)
        .json({
          error: "Failed to reach Alpaca Markets Data API.",
          details: e.message,
        });
    }
  });`;

const newQuoteEndpoint = `  // Endpoint: Alpaca Integration - Real Market Quote
  app.get("/api/v1/alpaca/quote", async (req: Request, res: Response) => {
    const symbol = req.query.symbol as string;
    if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) {
      return res
        .status(400)
        .json({
          error: "Missing ALPACA_API_KEY or ALPACA_SECRET_KEY in Environment",
        });
    }
    
    // Check WebSocket first
    if (liveQuotes[symbol] && liveQuotes[symbol].price > 0) {
      return res.json({
        quotes: {
          [symbol]: {
            ap: liveQuotes[symbol].ask,
            bp: liveQuotes[symbol].bid,
            price: liveQuotes[symbol].price,
            source: 'websocket'
          }
        }
      });
    }
    
    try {
      const response = await fetch(
        \`https://data.alpaca.markets/v2/stocks/quotes/latest?symbols=\${symbol}\`,
        {
          headers: {
            "APCA-API-KEY-ID": process.env.ALPACA_API_KEY,
            "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY,
          },
        },
      );
      const data = await response.json();
      if (!response.ok) return res.status(response.status).json(data);
      res.json(data);
    } catch (e: any) {
      res
        .status(500)
        .json({
          error: "Failed to reach Alpaca Markets Data API.",
          details: e.message,
        });
    }
  });`;

if (code.includes(targetQuoteEndpoint)) {
  code = code.replace(targetQuoteEndpoint, newQuoteEndpoint);
  fs.writeFileSync('server.ts', code);
  console.log("Endpoint refactored.");
} else {
  console.log("Could not find quote endpoint logic to replace");
}
