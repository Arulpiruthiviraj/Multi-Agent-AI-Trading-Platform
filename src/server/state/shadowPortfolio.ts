/**
 * Shadow portfolio state for the legacy "sovereign vs. shadow" trade
 * simulation in server.ts: a second, parallel paper ledger used to benchmark
 * the autonomous bot's real (sovereign) decisions against a shadow copy.
 *
 * Extracted structurally only. Exported as a mutable object (not just the
 * load/save functions) because both the shadow-trade execution logic and the
 * `/api/v1/autobot` GET route mutate/read the same in-memory instance —
 * matching the original single-`let` module state in server.ts exactly.
 */
import fs from "fs";
import path from "path";

export interface ShadowPosition {
  symbol: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  totalCost: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  sector: string;
  openedAt: string;
}

export interface ShadowPortfolioState {
  cash: number;
  initialCash: number;
  peakValuation: number;
  positions: ShadowPosition[];
}

const SHADOW_PORTFOLIO_FILE = path.join(process.cwd(), "data", "shadow_portfolio.json");

export function saveShadowPortfolio(state: ShadowPortfolioState): void {
  try {
    fs.mkdirSync(path.dirname(SHADOW_PORTFOLIO_FILE), { recursive: true });
    fs.writeFileSync(SHADOW_PORTFOLIO_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("Failed to save shadow portfolio to disk:", e);
  }
}

function loadShadowPortfolio(): ShadowPortfolioState {
  try {
    if (fs.existsSync(SHADOW_PORTFOLIO_FILE)) {
      return JSON.parse(fs.readFileSync(SHADOW_PORTFOLIO_FILE, "utf-8"));
    }
  } catch (e) {
    console.warn("Could not load shadow portfolio from disk, using defaults.");
  }
  const defaultShadow: ShadowPortfolioState = {
    cash: 95300.0,
    initialCash: 100000.0,
    peakValuation: 100000.0,
    positions: [
      {
        symbol: "AAPL",
        quantity: 10,
        entryPrice: 150.0,
        currentPrice: 155.0,
        totalCost: 1500.0,
        marketValue: 1550.0,
        unrealizedPnl: 50.0,
        unrealizedPnlPercent: 0.0333,
        sector: "Technology",
        openedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        symbol: "AMD",
        quantity: 15,
        entryPrice: 80.0,
        currentPrice: 75.0,
        totalCost: 1200.0,
        marketValue: 1125.0,
        unrealizedPnl: -75.0,
        unrealizedPnlPercent: -0.0625,
        sector: "Technology",
        openedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        symbol: "SPY",
        quantity: 5,
        entryPrice: 400.0,
        currentPrice: 405.0,
        totalCost: 2000.0,
        marketValue: 2025.0,
        unrealizedPnl: 25.0,
        unrealizedPnlPercent: 0.0125,
        sector: "Index Funds",
        openedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ],
  };
  saveShadowPortfolio(defaultShadow);
  return defaultShadow;
}

export const shadowPortfolioState: ShadowPortfolioState = loadShadowPortfolio();
