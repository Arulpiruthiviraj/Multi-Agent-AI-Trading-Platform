import { db } from '../db';
import { fills } from '../db/schema';
import { eq } from 'drizzle-orm';
  import { observeSafe, structuredLogger } from '../observability/StructuredLogger';
import { incMetric } from '../observability/ObservabilityMetrics';

function isUniqueConstraint(err: unknown): boolean {
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
}): Promise<{ newQty: number; cumulativeQuantity: number; duplicate: boolean }> {
  const reportedQty = typeof opts.filledQuantity === 'number' && opts.filledQuantity > 0
    ? opts.filledQuantity
    : (opts.status === 'FILLED' ? opts.requestedQuantity : 0);
  if (reportedQty <= 0) return { newQty: 0, cumulativeQuantity: 0, duplicate: false };

  let priorQty = 0;
  try {
    const priorFills = await db.select().from(fills).where(eq(fills.orderId, opts.orderId));
    priorQty = priorFills.reduce((sum: number, f: { quantity: number }) => sum + f.quantity, 0);
  } catch (e) {
    console.error(`[fillLedger] Failed to read prior fills for order ${opts.orderId} - skipping to avoid double-counting`, e);
    return { newQty: 0, cumulativeQuantity: 0, duplicate: false };
  }

  const newQty = reportedQty - priorQty;
  if (newQty <= 1e-9) return { newQty: 0, cumulativeQuantity: reportedQty, duplicate: false };

  const fillPrice = opts.averageFillPrice || 0;
  const filledAt = opts.filledAt || new Date().toISOString();
  const fillKey = opts.brokerFillId || `${opts.orderId}:${reportedQty}`;

  try {
    await db.insert(fills).values({
      orderId: opts.orderId,
      brokerFillId: fillKey,
      quantity: newQty,
      price: fillPrice,
      filledAt,
      cumulativeQuantity: reportedQty,
    });
    incMetric('fills_recorded');
    observeSafe(() => {
      structuredLogger.info('fill_recorded', {
        category: 'FILL',
        component: 'fillLedger',
        eventType: 'FILL_RECORDED',
        orderId: opts.orderId,
        newQty,
        cumulativeQuantity: reportedQty,
      });
    });
    return { newQty, cumulativeQuantity: reportedQty, duplicate: false };
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
