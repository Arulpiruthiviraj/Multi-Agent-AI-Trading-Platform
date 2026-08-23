/**
 * Immediate local `portfolio` sync after OMS SELL fill progress.
 * Decrements on partial closes; deletes the row on full close so PortfolioReconciliation
 * does not see stale localQty > 0 → false MISSING_REMOTELY between recon ticks.
 */
import { db } from '../db';
import { portfolio } from '../db/schema';
import { eq } from 'drizzle-orm';
import { tradingSafety } from '../config/tradingSafety';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';

const QTY_TOLERANCE = tradingSafety.reconQtyTolerance;

/**
 * Apply a SELL fill quantity to the local portfolio row.
 * remaining ≤ tolerance → DELETE row (full close).
 * else → decrement quantity + update lastUpdated.
 */
export async function syncLocalPortfolioAfterSellFill(
  symbol: string,
  soldQuantity: number,
): Promise<{ updated: boolean; remainingQty: number | null; deleted: boolean }> {
  if (!(soldQuantity > 0) || !symbol) {
    return { updated: false, remainingQty: null, deleted: false };
  }

  try {
    const rows = await db.select().from(portfolio).where(eq(portfolio.symbol, symbol)).limit(1);
    const local = rows[0];
    if (!local) {
      return { updated: false, remainingQty: null, deleted: false };
    }

    const prior = Number(local.quantity) || 0;
    const remaining = prior - soldQuantity;
    const now = new Date().toISOString();

    if (remaining <= QTY_TOLERANCE) {
      // Prefer DELETE so recon does not see a zero-qty ghost row; fall back to qty=0 if delete unavailable.
      try {
        await db.delete(portfolio).where(eq(portfolio.symbol, symbol));
      } catch {
        await db.update(portfolio).set({
          quantity: 0,
          lastUpdated: now,
        }).where(eq(portfolio.symbol, symbol));
      }
      observeSafe(() => {
        structuredLogger.info('local_portfolio_sell_fill_sync', {
          category: 'PORTFOLIO',
          component: 'localPortfolioSync',
          eventType: 'LOCAL_PORTFOLIO_SELL_FILL_SYNC',
          symbol,
          metadata: { priorQty: prior, soldQuantity, remainingQty: 0, deleted: true },
        });
      });
      return { updated: true, remainingQty: 0, deleted: true };
    }

    await db.update(portfolio).set({
      quantity: remaining,
      lastUpdated: now,
    }).where(eq(portfolio.symbol, symbol));

    observeSafe(() => {
      structuredLogger.info('local_portfolio_sell_fill_sync', {
        category: 'PORTFOLIO',
        component: 'localPortfolioSync',
        eventType: 'LOCAL_PORTFOLIO_SELL_FILL_SYNC',
        symbol,
        metadata: { priorQty: prior, soldQuantity, remainingQty: remaining, deleted: false },
      });
    });

    return { updated: true, remainingQty: remaining, deleted: false };
  } catch (e) {
    console.error(`[OMS] Failed to sync local portfolio after SELL fill for ${symbol}`, e);
    return { updated: false, remainingQty: null, deleted: false };
  }
}

/**
 * Immediate local portfolio upsert after OMS BUY fill — so Holdings reflect IB fills
 * before the next PortfolioReconciliation tick (fail-closed: never invents price).
 */
export async function syncLocalPortfolioAfterBuyFill(
  symbol: string,
  boughtQuantity: number,
  fillPrice: number,
  brokerSource?: string | null,
): Promise<{ updated: boolean }> {
  if (!(boughtQuantity > 0) || !symbol || !(fillPrice > 0)) {
    return { updated: false };
  }
  try {
    const rows = await db.select().from(portfolio).where(eq(portfolio.symbol, symbol)).limit(1);
    const now = new Date().toISOString();
    const local = rows[0];
    if (!local) {
      await db.insert(portfolio).values({
        symbol,
        quantity: boughtQuantity,
        averagePrice: fillPrice,
        currentPrice: fillPrice,
        lastUpdated: now,
        unrealizedPnL: 0,
        brokerSource: brokerSource || null,
      });
    } else {
      const priorQty = Number(local.quantity) || 0;
      const priorAvg = Number(local.averagePrice) || fillPrice;
      const newQty = priorQty + boughtQuantity;
      const newAvg = newQty > 0 ? ((priorAvg * priorQty) + fillPrice * boughtQuantity) / newQty : fillPrice;
      await db.update(portfolio).set({
        quantity: newQty,
        averagePrice: newAvg,
        currentPrice: fillPrice,
        lastUpdated: now,
        brokerSource: brokerSource || local.brokerSource,
      }).where(eq(portfolio.symbol, symbol));
    }
    observeSafe(() => {
      structuredLogger.info('local_portfolio_buy_fill_sync', {
        category: 'PORTFOLIO',
        component: 'localPortfolioSync',
        eventType: 'LOCAL_PORTFOLIO_BUY_FILL_SYNC',
        symbol,
        metadata: { boughtQuantity, fillPrice },
      });
    });
    return { updated: true };
  } catch (e) {
    console.error(`[OMS] Failed to sync local portfolio after BUY fill for ${symbol}`, e);
    return { updated: false };
  }
}

/** @deprecated Prefer syncLocalPortfolioAfterSellFill — alias kept for existing call sites/tests. */
export async function syncLocalPortfolioAfterFullSellFill(
  symbol: string,
  soldQuantity: number,
): Promise<{ updated: boolean; remainingQty: number | null }> {
  const r = await syncLocalPortfolioAfterSellFill(symbol, soldQuantity);
  return { updated: r.updated, remainingQty: r.remainingQty };
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
