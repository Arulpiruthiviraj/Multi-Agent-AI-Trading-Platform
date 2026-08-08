/**
 * ==========================================================
 * Module:
 * PortfolioMonitor.ts
 *
 * Purpose:
 * Core implementation and logic for the PortfolioMonitor.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for PortfolioMonitor
 * - Interface with backend APIs and EventBus
 * - Render UI components (if React)
 *
 * Inputs:
 * - Module dependencies and injected props
 *
 * Outputs:
 * - Formatted data or React Elements
 *
 * Emits:
 * - Relevant system events
 *
 * Dependencies:
 * - Standard Argus architecture layers
 *
 * Called By:
 * - Argus Routing / Parent Components
 *
 * Never:
 * - Mutate global state directly without EventBus
 * - Call AI providers directly (Must use AIRouter)
 *
 * ==========================================================
 */

import { eventBus } from '../core/EventBus';
import { db } from '../db';
import { portfolio } from '../db/schema';
import { marketDataWorker } from './MarketDataWorker';

export class PortfolioMonitorWorker {
  private intervalId: NodeJS.Timeout | null = null;

  start() {
    if (this.intervalId) return;
    console.log("[PortfolioWorker] Started monitoring loop.");
    this.intervalId = setInterval(() => this.reviewPortfolio(), 60000);
    this.reviewPortfolio();
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("[PortfolioWorker] Stopped.");
    }
  }

  async reviewPortfolio() {
    try {
      const holdings = await db.select().from(portfolio).all();
      if (holdings.length === 0) return;
      console.log(`[PortfolioWorker] Reviewing ${holdings.length} active positions.`);

      for (const holding of holdings) {
        if (holding.quantity <= 0) continue;
        
        const currentLivePrice = marketDataWorker.getLatestPrice(holding.symbol);
        if (!currentLivePrice) continue;

        const PnL = ((currentLivePrice - holding.averagePrice) / holding.averagePrice) * 100;
                
        if (PnL > 5.0) {
           console.log(`[PortfolioWorker] Taking profit on ${holding.symbol} (+${PnL.toFixed(2)}%)`);
           eventBus.emitTradeIdea({
             traceId: Math.random().toString(36).substring(7),
             symbol: holding.symbol,
             side: "SELL",
             confidence: 0.85,
             reasoning: `Target profit reached (+${PnL.toFixed(2)}%). Scaling out to manage risk.`,
             agent: "PortfolioManager"
           });
        } else if (PnL < -3.0) {
           console.log(`[PortfolioWorker] Cutting loss on ${holding.symbol} (${PnL.toFixed(2)}%)`);
           eventBus.emitTradeIdea({
             traceId: Math.random().toString(36).substring(7),
             symbol: holding.symbol,
             side: "SELL",
             confidence: 0.95,
             reasoning: `Hard stop hit (${PnL.toFixed(2)}%). Preserving capital.`,
             agent: "PortfolioManager"
           });
        }
      }
    } catch (e) {
      console.error("[PortfolioWorker] Error during review:", e);
    }
  }
}

export const portfolioMonitor = new PortfolioMonitorWorker();
