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
import { BrokerPlugin, Order } from '../../brokers/BrokerAdapter';

export class OrderManagementService {
  constructor() {
    eventBus.on('RISK_ASSESSMENT_COMPLETED', async (assessment) => {
      if (assessment.approved && assessment.maxQuantity > 0) {
        await this.executeOrder(assessment.symbol, assessment.side, assessment.maxQuantity, assessment.reasoning, assessment.traceId, assessment.newsDetails);
      }
    });
  }

  // InternalPaperBroker.placeOrder() only queues the order - it fills on the broker's next
  // tick() (every 1s, driven by market data). Alpaca orders can similarly settle a moment after
  // acceptance. Poll briefly for a terminal status rather than recording "PENDING" forever with
  // no fill price - never fabricates a fill; if it's still pending after the timeout, that's
  // recorded honestly.
  private async pollForFill(broker: BrokerPlugin, orderId: string, timeoutMs = 4000, intervalMs = 400): Promise<Order | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, intervalMs));
      try {
        const orders = await broker.orders();
        const match = orders.find(o => o.id === orderId);
        if (match && match.status !== 'PENDING') return match;
      } catch (e) {}
    }
    return null;
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
    let profitLoss: number | null = null;

    try {
      const activeBroker = BrokerManager.getInstance().getActiveBroker();
      console.log(`[OMS] Submitting order to ${activeBroker.name}: ${side} ${quantity}x ${symbol}`);

      // Capture the pre-trade entry price so a SELL's realized P&L can be computed once it fills.
      let preTradeEntryPrice: number | null = null;
      if (side === 'SELL') {
        try {
          const positions = await activeBroker.positions();
          preTradeEntryPrice = positions.find(p => p.symbol === symbol)?.entryPrice ?? null;
        } catch (e) {}
      }

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

      if (status === 'PENDING' && brokerOrder.id) {
        const terminal = await this.pollForFill(activeBroker, brokerOrder.id);
        if (terminal) {
          status = terminal.status;
          if (terminal.averageFillPrice) fillPrice = terminal.averageFillPrice;
        }
      }

      if (side === 'SELL' && status === 'FILLED' && preTradeEntryPrice !== null && fillPrice > 0) {
        profitLoss = Number(((fillPrice - preTradeEntryPrice) * quantity).toFixed(2));
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
