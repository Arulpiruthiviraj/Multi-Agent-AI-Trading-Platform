// @ts-nocheck
import { db } from '../db';
import { fills } from '../db/schema';
import { eq } from 'drizzle-orm';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';
import { incMetric } from '../observability/ObservabilityMetrics';

export function isUniqueConstraint(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(String(e?.message || ''));
}

/**
 * Records the incremental fill since last persisted fills for this order.
 * Identity is (orderId, cumulativeQuantity=broker reported filled qty). Duplicate
 * WS/REST/retry of the same cumulative watermark is a unique-constraint no-op.
 */
export async function insertIncrementalFill(opts: {
  orderId: string;
  brokerOrderId: string | null;
  brokerFillId?: string | null;
  requestedQuantity: number;
  status: string;
  filledQuantity: number | undefined;
  averageFillPrice: number | undefined;
  filledAt?: string;
}): Promise<{ newQty: number; cumulativeQuantity: number; duplicate: boolean; incrementalPrice?: number }> {
  const reportedQty = opts.filledQuantity;
  if (reportedQty === 0) return { newQty: 0, cumulativeQuantity: 0, duplicate: false };
  if (!Number.isFinite(reportedQty) || !(reportedQty! > 0)
    || !Number.isFinite(opts.requestedQuantity) || !(opts.requestedQuantity > 0)
    || reportedQty! > opts.requestedQuantity
    || !Number.isFinite(opts.averageFillPrice) || !(opts.averageFillPrice! > 0)) {
    throw new Error(`Invalid or incomplete broker fill for ${opts.orderId}; reconciliation required`);
  }
  try {
    // Synchronous transaction: no await may split reading the watermark from its update.
    // IMMEDIATE also prevents another connection from racing the read/insert pair.
    const result = db.transaction((tx) => {
      const prior = tx.select().from(fills).where(eq(fills.orderId, opts.orderId)).all();
      if (prior.some(f => !Number.isFinite(f.quantity) || !(f.quantity > 0)
        || !Number.isFinite(f.price) || !(f.price > 0))) {
        throw new Error(`Invalid existing fill economics for ${opts.orderId}; reconciliation required`);
      }
      const priorQty = prior.reduce((sum, f) => sum + f.quantity, 0);
      const newQty = reportedQty! - priorQty;
      if (newQty <= 1e-9) return { newQty: 0, cumulativeQuantity: reportedQty!, duplicate: true };
      const priorNotional = prior.reduce((sum, f) => sum + f.quantity * f.price, 0);
      const incrementalPrice = (reportedQty! * opts.averageFillPrice! - priorNotional) / newQty;
      if (!Number.isFinite(incrementalPrice) || !(incrementalPrice > 0)) {
        throw new Error(`Non-positive incremental fill value for ${opts.orderId}; reconciliation required`);
      }
      tx.insert(fills).values({
        orderId: opts.orderId,
        brokerFillId: opts.brokerFillId || `${opts.orderId}:${reportedQty}`,
        quantity: newQty,
        price: incrementalPrice,
        filledAt: opts.filledAt || new Date().toISOString(),
        cumulativeQuantity: reportedQty,
      }).run();
      return { newQty, cumulativeQuantity: reportedQty!, duplicate: false, incrementalPrice };
    }, { behavior: 'immediate' });
    if (result.newQty === 0) return result;
    incMetric('fills_recorded');
    observeSafe(() => {
      structuredLogger.info('fill_recorded', {
        category: 'FILL',
        component: 'fillLedger',
        eventType: 'FILL_RECORDED',
        orderId: opts.orderId,
        newQty: result.newQty,
        cumulativeQuantity: reportedQty,
      });
    });
    return result;
  } catch (e) {
    if (isUniqueConstraint(e)) {
      incMetric('fills_duplicate');
      observeSafe(() => {
        structuredLogger.info('fill_duplicate', {
          category: 'FILL',
          component: 'fillLedger',
          eventType: 'FILL_DUPLICATE',
          orderId: opts.orderId,
          cumulativeQuantity: reportedQty,
        });
      });
      return { newQty: 0, cumulativeQuantity: reportedQty, duplicate: true };
    }
    console.error(`[fillLedger] Failed to insert fill for order ${opts.orderId}`, e);
    throw e;
  }
}
