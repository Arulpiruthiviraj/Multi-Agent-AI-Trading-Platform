import { db } from '../db';
import { portfolio, trades } from '../db/schema';
import { eq } from 'drizzle-orm';
import fetch from 'node-fetch';

export class PortfolioReconciliationWorker {
  private intervalId: NodeJS.Timeout | null = null;
  
  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.reconcile(), 60000 * 5); // Every 5 minutes
    this.reconcile();
  }
  
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async reconcile() {
    if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY || process.env.PAPER_TRADING_ONLY === "false") {
       console.log("[PortfolioReconciliation] Skipping sync, no valid Alpaca keys or LIVE mode disabled.");
       return;
    }

    try {
      console.log("[PortfolioReconciliation] Syncing local portfolio with broker...");
      
      const res = await fetch("https://paper-api.alpaca.markets/v2/positions", {
        headers: {
          "APCA-API-KEY-ID": process.env.ALPACA_API_KEY,
          "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY
        }
      });
      
      if (!res.ok) {
        console.error("[PortfolioReconciliation] Failed to fetch positions:", await res.text());
        return;
      }
      
      const remotePositions = await res.json();
      
      const localHoldings = await db.select().from(portfolio).all();
      
      // Update local to match remote
      for (const pos of remotePositions) {
        const symbol = pos.symbol;
        const qty = parseFloat(pos.qty);
        const avgPrice = parseFloat(pos.avg_entry_price);
        
        const local = localHoldings.find(h => h.symbol === symbol);
        if (local) {
          if (local.quantity !== qty || local.averagePrice !== avgPrice) {
            console.log(`[PortfolioReconciliation] Repairing ${symbol}: Local qty ${local.quantity}, Remote qty ${qty}`);
            await db.update(portfolio).set({
              quantity: qty,
              averagePrice: avgPrice,
              lastUpdated: new Date().toISOString()
            }).where(eq(portfolio.symbol, symbol));
          }
        } else {
           console.log(`[PortfolioReconciliation] Adding missing remote position to local: ${symbol} (${qty})`);
           await db.insert(portfolio).values({
             symbol,
             quantity: qty,
             averagePrice: avgPrice,
             lastUpdated: new Date().toISOString()
           });
        }
      }
      
      // Remove locals not in remote
      for (const local of localHoldings) {
        if (!remotePositions.find((r: any) => r.symbol === local.symbol) && local.quantity > 0) {
           console.log(`[PortfolioReconciliation] Removing non-existent local position: ${local.symbol}`);
           await db.update(portfolio).set({
             quantity: 0,
             lastUpdated: new Date().toISOString()
           }).where(eq(portfolio.symbol, local.symbol));
        }
      }
      
      console.log("[PortfolioReconciliation] Sync complete.");
    } catch (e) {
       console.error("[PortfolioReconciliation] Error during sync:", e);
    }
  }
}

export const portfolioReconciliationWorker = new PortfolioReconciliationWorker();
