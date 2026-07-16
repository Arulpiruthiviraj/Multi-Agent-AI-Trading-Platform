import { eventBus } from '../core/EventBus';
import { db } from '../db';
import { portfolio } from '../db/schema';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "mock-key" });

export class PortfolioMonitorWorker {
  private intervalId: NodeJS.Timeout | null = null;

  start() {
    if (this.intervalId) return;
    console.log("[PortfolioWorker] Started monitoring loop.");
    // Run every minute (using 60s for demo, could be longer)
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

      // Simple mock AI evaluation of current holdings
      // In production, this agent queries market context for each symbol
      for (const holding of holdings) {
        if (holding.quantity <= 0) continue;

        // Simulate logic: If we have a position, occasionally decide to trim/sell based on momentum
        const PnL = holding.currentPrice ? ((holding.currentPrice - holding.averagePrice) / holding.averagePrice) * 100 : 0;
        
        if (PnL > 5.0) { // Take profit condition
           console.log(`[PortfolioWorker] Taking profit on ${holding.symbol} (+${PnL.toFixed(2)}%)`);
           eventBus.emitTradeIdea({
             symbol: holding.symbol,
             side: "SELL",
             confidence: 0.85,
             reasoning: `Target profit reached (+${PnL.toFixed(2)}%). Scaling out to manage risk.`,
             agent: "PortfolioManager"
           });
        } else if (PnL < -3.0) { // Stop loss condition
           console.log(`[PortfolioWorker] Cutting loss on ${holding.symbol} (${PnL.toFixed(2)}%)`);
           eventBus.emitTradeIdea({
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
