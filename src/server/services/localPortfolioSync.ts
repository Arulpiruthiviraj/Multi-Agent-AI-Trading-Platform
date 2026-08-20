/**
 * Immediate local `portfolio` sync after OMS fill progress.
 * Clears / reduces rows on full SELL fills so PortfolioReconciliation does not see
 * stale localQty > 0 → false MISSING_REMOTELY between recon ticks.
 * Mirrors PortfolioReconciliation's quantity=0 clear path (does not invent fills).
 */
import { db } from '../db';
import { portfolio } from '../db/schema';
import { eq } from 'drizzle-orm';
import { tradingSafety } from '../config/tradingSafety';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';

const QTY_TOLERANCE = tradingSafety.reconQtyTolerance;

/**
 * After a SELL order reaches full fill (cumulativeQuantity >= order quantity),
 * subtract sold qty from the local portfolio row. Remaining ≤ tolerance → quantity 0
 * (same as recon clear), else leave the reduced remainder.
 */
export async function syncLocalPortfolioAfterFullSellFill(
  symbol: string,
  soldQuantity: number,
): Promise<{ updated: boolean; remainingQty: number | null }> {
  if (!(soldQuantity > 0) || !symbol) {
    return { updated: false, remainingQty: null };
  }

  try {
    const rows = await db.select().from(portfolio).where(eq(portfolio.symbol, symbol)).limit(1);
    const local = rows[0];
    if (!local) {
      return { updated: false, remainingQty: null };
    }

    const prior = Number(local.quantity) || 0;
    const remaining = prior - soldQuantity;
    const nextQty = remaining <= QTY_TOLERANCE ? 0 : remaining;
    const now = new Date().toISOString();

    await db.update(portfolio).set({
      quantity: nextQty,
      lastUpdated: now,
    }).where(eq(portfolio.symbol, symbol));

    observeSafe(() => {
      structuredLogger.info('local_portfolio_sell_fill_sync', {
        category: 'PORTFOLIO',
        component: 'localPortfolioSync',
        eventType: 'LOCAL_PORTFOLIO_SELL_FILL_SYNC',
        symbol,
        metadata: { priorQty: prior, soldQuantity, remainingQty: nextQty },
      });
    });

    return { updated: true, remainingQty: nextQty };
  } catch (e) {
    console.error(`[OMS] Failed to sync local portfolio after SELL fill for ${symbol}`, e);
    return { updated: false, remainingQty: null };
  }
}

/** True when broker-reported cumulative fill covers the full order quantity. */
export function isOrderFullyFilled(
  status: string,
  cumulativeQuantity: number,
  requestedQuantity: number,
): boolean {
  if (status === 'FILLED') return true;
  return cumulativeQuantity > 0
    && requestedQuantity > 0
    && cumulativeQuantity + QTY_TOLERANCE >= requestedQuantity;
}
