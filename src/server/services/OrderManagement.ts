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

  async executeOrder(symbol: string, side: string, quantity: number, reasoning: string, traceId: string, newsDetails?: any) {
    // Idempotency: refuse to place a second real order for a traceId that already has one.
    // Guards against any future duplicate RISK_ASSESSMENT_COMPLETED emission for the same trade.
    try {
      const existing = await db.select().from(trades).where(eq(trades.traceId, traceId)).limit(1);
      if (existing.length > 0) {
        console.warn(`[OMS] Duplicate execution attempt for traceId ${traceId} - an order was already placed (${existing[0].id}). Skipping.`);
        return;
      }
    } catch (e) {
      console.error('[OMS] Idempotency check failed, proceeding without it', e);
    }

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
    } catch (e) {
      console.error("[OMS] Broker execution failed.", e);
      status = "REJECTED";
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
        status
      });
      
      console.log(`[OMS] Order ${orderId} finalized with status: ${status}.`);
    } catch (error) {
      console.error(`[OMS] Failed to record order for ${symbol}:`, error);
    }
  }
}

export const oms = new OrderManagementService();
