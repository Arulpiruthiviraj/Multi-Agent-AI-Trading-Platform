const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const targetNewsEndpoint = `  // Endpoint: Alpaca Integration - Real Market News
  app.get("/api/v1/alpaca/news", async (req: Request, res: Response) => {
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
        \`https://data.alpaca.markets/v1beta1/news?symbols=\${symbol}&limit=5\`,
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
          error: "Failed to reach Alpaca Markets News API.",
          details: e.message,
        });
    }
  });`;

const newNewsEndpoint = `  // Endpoint: Alpaca Integration - Real Market News
  app.get("/api/v1/alpaca/news", async (req: Request, res: Response) => {
    const symbol = req.query.symbol as string;
    if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) {
      return res
        .status(400)
        .json({
          error: "Missing ALPACA_API_KEY or ALPACA_SECRET_KEY in Environment",
        });
    }
    
    // Check WebSocket first
    if (liveNews[symbol] && liveNews[symbol].length > 0) {
      return res.json({
        news: liveNews[symbol].map((n: any) => ({
           id: n.id,
           headline: n.headline,
           summary: n.summary,
           author: n.author,
           created_at: n.created_at,
           updated_at: n.updated_at,
           url: n.url,
           source: n.source || 'websocket'
        }))
      });
    }
    
    try {
      const response = await fetch(
        \`https://data.alpaca.markets/v1beta1/news?symbols=\${symbol}&limit=5\`,
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
          error: "Failed to reach Alpaca Markets News API.",
          details: e.message,
        });
    }
  });`;

if (code.includes(targetNewsEndpoint)) {
  code = code.replace(targetNewsEndpoint, newNewsEndpoint);
  fs.writeFileSync('server.ts', code);
  console.log("Endpoint refactored.");
} else {
  console.log("Could not find news endpoint logic to replace");
}
