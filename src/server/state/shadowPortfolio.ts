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
  // Starts empty (no fabricated positions) - the shadow ledger only ever
  // reflects trades actually mirrored from real CHIEF_APPROVED_IDEA events.
  const defaultShadow: ShadowPortfolioState = {
    cash: 100000.0,
    initialCash: 100000.0,
    peakValuation: 100000.0,
    positions: [],
  };
  saveShadowPortfolio(defaultShadow);
  return defaultShadow;
}

export const shadowPortfolioState: ShadowPortfolioState = loadShadowPortfolio();
