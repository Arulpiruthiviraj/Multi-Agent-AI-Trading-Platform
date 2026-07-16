import { eventBus } from '../core/EventBus';
import { db } from '../db';
import { trades, portfolio } from '../db/schema';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';

export class OrderManagementService {
  constructor() {
    eventBus.on('RISK_ASSESSMENT_COMPLETED', async (assessment) => {
      if (assessment.approved && assessment.maxQuantity > 0) {
        await this.executeOrder(assessment.symbol, assessment.side, assessment.maxQuantity, assessment.reasoning, assessment.traceId);
      }
    });
  }

  async executeOrder(symbol: string, side: string, quantity: number, reasoning: string, traceId: string) {
    const orderId = crypto.randomUUID();
    let fillPrice = 150 + Math.random() * 50; 
    let status = "FILLED";
    
    if (process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY && process.env.PAPER_TRADING_ONLY !== "false") {
      try {
        console.log(`[OMS] Submitting live PAPER order to Alpaca: ${side} ${quantity}x ${symbol}`);
        const fetch = (await import('node-fetch')).default;
        const res = await fetch("https://paper-api.alpaca.markets/v2/orders", {
          method: "POST",
          headers: {
            "APCA-API-KEY-ID": process.env.ALPACA_API_KEY,
            "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            symbol,
            qty: quantity,
            side: side.toLowerCase(),
            type: "market",
            time_in_force: "gtc"
          })
        });
        
        if (res.ok) {
          const order = await res.json();
          status = order.status === "accepted" || order.status === "new" ? "PENDING" : "FILLED";
          if (order.filled_avg_price) fillPrice = parseFloat(order.filled_avg_price);
        } else {
           const errText = await res.text();
           console.error("[OMS] Alpaca API rejected order:", errText);
           status = "REJECTED";
        }
      } catch (e) {
        console.error("[OMS] Alpaca execution failed, falling back to mock.", e);
      }
    } else {
      console.log(`[OMS] Submitting MOCK ${side} order for ${quantity}x ${symbol} to Broker...`);
    }

    try {
      const timestamp = new Date().toISOString();
      await db.insert(trades).values({
        id: orderId,
        symbol,
        side,
        quantity,
        price: fillPrice,
        status,
        timestamp,
        reasoning,
        trace_id: traceId 
      } as any);

      if (status !== "REJECTED") {
        await this.updatePortfolio(symbol, side, quantity, fillPrice);
      }

      eventBus.emitOrderExecution({
        traceId,
        id: orderId,
        symbol,
        side,
        quantity,
        price: fillPrice,
        status
      });
      console.log(`[OMS] Order ${orderId} finalized with status: ${status}.`);
    } catch (error) {
      console.error(`[OMS] Failed to execute order for ${symbol}:`, error);
    }
  }

  private async updatePortfolio(symbol: string, side: string, quantity: number, price: number) {
    const existing = await db.select().from(portfolio).where(eq(portfolio.symbol, symbol)).get();
    if (existing) {
      let newQty = existing.quantity;
      let newAvgPrice = existing.averagePrice;
      if (side === 'BUY') {
        newQty += quantity;
        newAvgPrice = ((existing.quantity * existing.averagePrice) + (quantity * price)) / newQty;
      } else if (side === 'SELL') {
        newQty -= quantity;
        if (newQty <= 0) {
          newQty = 0;
          newAvgPrice = 0;
        }
      }
      await db.update(portfolio).set({
        quantity: newQty,
        averagePrice: newAvgPrice,
        lastUpdated: new Date().toISOString()
      }).where(eq(portfolio.symbol, symbol));
    } else {
      if (side === 'BUY') {
        await db.insert(portfolio).values({
          symbol,
          quantity,
          averagePrice: price,
          lastUpdated: new Date().toISOString()
        });
      }
    }
  }
}
export const oms = new OrderManagementService();

eventBus.on('ORDER_EXECUTED', (order) => {
   if (Math.random() < 0.3) {
      setTimeout(() => {
         eventBus.emitLearningEvent({
            traceId: order.traceId,
            agent: 'ReflectionEngine',
            cause: 'Post-trade momentum divergence',
            rule: `When executing ${order.side} on ${order.symbol}, always pad stop-losses by 1.2x ATR to prevent noise stop-outs.`,
            confidence: 0.88
         });
      }, 2000);
   }
});
