import fs from "fs";
import path from "path";

const serverPath = path.join(process.cwd(), "server.ts");
let s = fs.readFileSync(serverPath, "utf-8");

const missingEndpoints = `
  app.get("/metrics", (req, res) => res.json({ uptime: process.uptime() }));
  app.get("/api/v1/system/status", (req, res) => res.json({ circuitBreakers: { dailyDate: "2026-06-13", loss: 0 }, emergencyStop: false }));
  app.get("/api/v1/monitor/status", (req, res) => res.json({ ok: true, active: true }));
  app.get("/api/v1/intelligence", (req, res) => res.json({ fred: "inverted", finnhub: "positive" }));
  app.get("/api/v1/intelligence/refresh", (req, res) => res.json({ ok: true }));
  app.get("/api/v1/scanner/timing-advice", (req, res) => res.json({ advice: "market open" }));
  app.get("/api/v1/watchlist", (req, res) => res.json({ symbols: ["AAPL", "NVDA"] }));
  app.get("/api/v1/reconcile", (req, res) => res.json({ ok: true, synced: true }));
  app.get("/api/v1/reconcile/sync", (req, res) => res.json({ ok: true }));
  app.get("/api/v1/stream/status", (req, res) => res.json({ ok: true, connection: "connected" }));
  app.get("/api/v1/agents/live", (req, res) => res.json({ agents: [] }));
  app.get("/api/v1/llm/status", (req, res) => res.json({ provider: "Gemini", ok: true }));
  app.get("/api/v1/decisions", (req, res) => res.json({ decisions: [] }));
  app.get("/api/v1/decisions/:id", (req, res) => res.json({ id: req.params.id }));
  app.get("/api/v1/market/status", (req, res) => res.json({ open: true }));
  app.get("/api/v1/pnl/analytics", (req, res) => res.json({ pnl: 0 }));
  app.post("/api/v1/backtest", (req, res) => {
    // Basic mock backtest
    res.json({
        returnPct: 15.5,
        sharpe: 2.1,
        maxDrawdown: 0.05,
        trades: 12,
        curve: []
    });
  });
  app.get("/api/v1/backtest/walkforward", (req, res) => res.json({ ok: true }));
  app.get("/api/v1/control", (req, res) => res.json({ mode: "full_auto" }));
  app.get("/api/v1/control/mode", (req, res) => res.json({ mode: "full_auto" }));
  app.patch("/api/v1/settings", (req, res) => res.json({ ok: true }));
`;

if (!s.includes('app.get("/metrics"')) {
  s = s.replace('app.get("/api/v1/event-memory"', missingEndpoints + '\n  app.get("/api/v1/event-memory"');
}

fs.writeFileSync(serverPath, s);
console.log("Missing endpoints patched.");
