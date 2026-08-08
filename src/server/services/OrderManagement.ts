/**
 * ==========================================================
 * Module: OrderManagement.ts
 *
 * Purpose:
 * Executes broker orders safely, logging failures as REJECTED.
 *
 * Responsibilities:
 * - Communicate with active broker.
 * - Insert trades into SQLite.
 * - Never fabricate fill prices if broker rejects.
 * ==========================================================
 */
import { eventBus } from '../core/EventBus';
import { db } from '../db';
import { trades, portfolio } from '../db/schema';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';
import { BrokerManager } from '../../brokers/BrokerManager';

export class OrderManagementService {
  constructor() {
    eventBus.on('RISK_ASSESSMENT_COMPLETED', async (assessment) => {
      if (assessment.approved && assessment.maxQuantity > 0) {
        await this.executeOrder(assessment.symbol, assessment.side, assessment.maxQuantity, assessment.reasoning, assessment.traceId, assessment.newsDetails);
      }
    });
  }

  // Some paper brokers (e.g. the internal simulator) fill orders asynchronously on the next
  // price tick rather than synchronously inside placeOrder(). Give the fill a brief window to
  // land instead of permanently recording real trades as PENDING.
  private async waitForFill(broker: any, orderId: string, attempts = 5, delayMs = 400): Promise<{ status: string; fillPrice: number } | null> {
    for (let i = 0; i < attempts; i++) {
      try {
        const orders = await broker.orders();
        const match = orders.find((o: any) => o.id === orderId);
        if (match && match.status !== 'PENDING') {
          return { status: match.status, fillPrice: match.averageFillPrice || 0 };
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, delayMs));
    }
    return null;
  }

  async executeOrder(symbol: string, side: string, quantity: number, reasoning: string, traceId: string, newsDetails?: any) {
    const orderId = crypto.randomUUID();
    let fillPrice = 0;
    let status = "PENDING";

    try {
      const activeBroker = BrokerManager.getInstance().getActiveBroker();
      console.log(`[OMS] Submitting order to ${activeBroker.name}: ${side} ${quantity}x ${symbol}`);

      const brokerOrder = await activeBroker.placeOrder({
          symbol,
          side: side as 'BUY' | 'SELL',
          type: 'MARKET',
          quantity
      });

      status = brokerOrder.status || "REJECTED";
      if (brokerOrder.averageFillPrice) {
          fillPrice = brokerOrder.averageFillPrice;
      }

      if (status === 'PENDING') {
        const resolved = await this.waitForFill(activeBroker, brokerOrder.id);
        if (resolved) {
          status = resolved.status;
          if (resolved.fillPrice > 0) fillPrice = resolved.fillPrice;
        }
      }
    } catch (e) {
      console.error("[OMS] Broker execution failed.", e);
      status = "REJECTED";
    }

    // Realized P&L for closing (SELL) fills, using the last reconciled cost basis. Left
    // undefined - not zero - when we can't establish a real cost basis, so the RiskEngine's
    // daily-loss/consecutive-loss circuit breakers never mistake "unknown" for "breakeven".
    let profitLoss: number | undefined = undefined;
    if (side === 'SELL' && status === 'FILLED' && fillPrice > 0) {
      try {
        const existing = await db.select().from(portfolio).where(eq(portfolio.symbol, symbol)).limit(1);
        const avgPrice = existing[0]?.averagePrice;
        if (avgPrice && avgPrice > 0) {
          profitLoss = (fillPrice - avgPrice) * quantity;
        }
      } catch (e) {}
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
        traceId,
        profitLoss,
        newsUsed: !!newsDetails,
        newsSentiment: newsDetails?.sentiment,
        newsConfidence: newsDetails?.confidence,
        newsSources: newsDetails?.sources,
        newsReasoning: newsDetails?.reasoning
      } as any);

      eventBus.emitOrderExecution({
        traceId,
        id: orderId,
        symbol,
        side,
        quantity,
        price: fillPrice,
        status,
        profitLoss
      });

      console.log(`[OMS] Order ${orderId} finalized with status: ${status}.`);
    } catch (error) {
      console.error(`[OMS] Failed to record order for ${symbol}:`, error);
    }
  }
}

export const oms = new OrderManagementService();
