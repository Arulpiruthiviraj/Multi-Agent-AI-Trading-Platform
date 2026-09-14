/**
 * Immediate local `portfolio` sync after OMS SELL fill progress.
 * Decrements on partial closes; deletes the row on full close so PortfolioReconciliation
 * does not see stale localQty > 0 → false MISSING_REMOTELY between recon ticks.
 *
 * Concurrency (2026-09-14 forensic audit pass 3, item 4 - position lifecycle race): both sync
 * functions below read-then-write `portfolio` with no guard against two fills for the SAME symbol
 * (e.g. a BUY add and a concurrent SELL trim, or two independently-approved orders on the same
 * symbol) landing close enough to race - a plain unconditional UPDATE/INSERT would silently lose
 * one delta (a real understated/overstated local position RiskEngine's concentration/correlation
 * gates then read) or, for a symbol with no existing row yet, throw an uncaught primary-key
 * collision on the second concurrent INSERT (portfolio.symbol is the PK) that the prior code's
 * outer catch would swallow, silently dropping that fill's portfolio effect entirely until the
 * next reconciliation tick. Fixed with an optimistic-concurrency retry loop: each write is a CAS
 * (`WHERE symbol = ? AND quantity = <value just read>`) and a losing writer re-reads fresh state
 * and retries, rather than either being silently dropped.
 *
 * Hardening (same pass, found via full-suite stress evidence): the retry loop's outer catch
 * originally treated ANY exception - not just the two expected, gracefully-retryable cases (a
 * unique-constraint collision on INSERT, a changes=0 CAS miss) - as fatal, giving up immediately
 * with no retry. `busy_timeout=5000` (`src/server/db/index.ts`) exists specifically because a real
 * SQLITE_BUSY (lock contention under real concurrent load) is an anticipated, retryable condition,
 * not a fatal one - a full 490-file suite run surfaced this exact gap where an isolated run of this
 * file alone did not. `isRetryableTransientError()` now lets the loop retry a real transient error
 * with a short backoff instead of bailing out on attempt 1.
 *
 * Second hardening (same pass, found via the operator's own explicit N-writer invariant testing
 * requirement): optimistic-concurrency CAS resolves AT MOST ONE competing writer per contention
 * round in the fully-synchronized worst case (every other writer's CAS necessarily fails against
 * whichever one just committed) - so N genuinely simultaneous writers on the same row can require
 * up to N attempts for the unluckiest one, not O(1). `MAX_SYNC_ATTEMPTS=8` (its original, arbitrary
 * value) measurably failed a real 10-concurrent-writer test on this exact reasoning before this
 * value was raised - not a hypothetical, a reproduced test failure. 25 gives real headroom above
 * any realistic real-world simultaneous-fill count for one symbol, plus slack for transient-error
 * retries layered on top of CAS retries within the same budget.
 */
import { db } from '../db';
import { portfolio } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { tradingSafety } from '../config/tradingSafety';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';
import { isUniqueConstraint } from './fillLedger';

const QTY_TOLERANCE = tradingSafety.reconQtyTolerance;
const MAX_SYNC_ATTEMPTS = 25;
const RETRY_BACKOFF_MS = 5;

export function isRetryableTransientError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  const code = String(e?.code || '');
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || code === 'SQLITE_LOCKED') return true;
  return /database is locked|SQLITE_BUSY/i.test(String(e?.message || ''));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  for (let attempt = 0; attempt < MAX_SYNC_ATTEMPTS; attempt++) {
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
        // Prefer DELETE so recon does not see a zero-qty ghost row; fall back to qty=0 if delete
        // unavailable (a real exception, e.g. an FK constraint - not the race case below).
        let deleted = true;
        try {
          const delResult = await db.delete(portfolio)
            .where(and(eq(portfolio.symbol, symbol), eq(portfolio.quantity, local.quantity)));
          if ((delResult as { changes: number }).changes === 0) continue; // row changed since our read - retry fresh
        } catch (delErr) {
          if (isRetryableTransientError(delErr)) {
            await sleep(RETRY_BACKOFF_MS);
            continue;
          }
          const updResult = await db.update(portfolio).set({
            quantity: 0,
            lastUpdated: now,
          }).where(and(eq(portfolio.symbol, symbol), eq(portfolio.quantity, local.quantity)));
          if ((updResult as { changes: number }).changes === 0) continue;
          deleted = false;
        }
        observeSafe(() => {
          structuredLogger.info('local_portfolio_sell_fill_sync', {
            category: 'PORTFOLIO',
            component: 'localPortfolioSync',
            eventType: 'LOCAL_PORTFOLIO_SELL_FILL_SYNC',
            symbol,
            metadata: { priorQty: prior, soldQuantity, remainingQty: 0, deleted },
          });
        });
        return { updated: true, remainingQty: 0, deleted };
      }

      const updResult = await db.update(portfolio).set({
        quantity: remaining,
        lastUpdated: now,
      }).where(and(eq(portfolio.symbol, symbol), eq(portfolio.quantity, local.quantity)));
      if ((updResult as { changes: number }).changes === 0) continue; // lost the race - retry against fresh state

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
      if (isRetryableTransientError(e) && attempt < MAX_SYNC_ATTEMPTS - 1) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      console.error(`[OMS] Failed to sync local portfolio after SELL fill for ${symbol}`, e);
      return { updated: false, remainingQty: null, deleted: false };
    }
  }
  console.error(`[OMS] Failed to sync local portfolio after SELL fill for ${symbol} - lost the concurrency race ${MAX_SYNC_ATTEMPTS} times in a row`);
  return { updated: false, remainingQty: null, deleted: false };
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
  for (let attempt = 0; attempt < MAX_SYNC_ATTEMPTS; attempt++) {
    try {
      const rows = await db.select().from(portfolio).where(eq(portfolio.symbol, symbol)).limit(1);
      const now = new Date().toISOString();
      const local = rows[0];
      if (!local) {
        try {
          await db.insert(portfolio).values({
            symbol,
            quantity: boughtQuantity,
            averagePrice: fillPrice,
            currentPrice: fillPrice,
            lastUpdated: now,
            unrealizedPnL: 0,
            brokerSource: brokerSource || null,
          });
        } catch (e) {
          // A concurrent BUY fill for the same not-yet-tracked symbol won the INSERT race first
          // (portfolio.symbol is the PK) - retry as an UPDATE against the row it just created,
          // rather than letting this fill's quantity silently vanish from local portfolio.
          if (isUniqueConstraint(e)) continue;
          if (isRetryableTransientError(e)) {
            await sleep(RETRY_BACKOFF_MS);
            continue;
          }
          throw e;
        }
      } else {
        const priorQty = Number(local.quantity) || 0;
        const priorAvg = Number(local.averagePrice) || fillPrice;
        const newQty = priorQty + boughtQuantity;
        const newAvg = newQty > 0 ? ((priorAvg * priorQty) + fillPrice * boughtQuantity) / newQty : fillPrice;
        const updResult = await db.update(portfolio).set({
          quantity: newQty,
          averagePrice: newAvg,
          currentPrice: fillPrice,
          lastUpdated: now,
          brokerSource: brokerSource || local.brokerSource,
        }).where(and(eq(portfolio.symbol, symbol), eq(portfolio.quantity, local.quantity), eq(portfolio.averagePrice, local.averagePrice)));
        if ((updResult as { changes: number }).changes === 0) continue; // lost the race - retry against fresh state
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
      if (isRetryableTransientError(e) && attempt < MAX_SYNC_ATTEMPTS - 1) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      console.error(`[OMS] Failed to sync local portfolio after BUY fill for ${symbol}`, e);
      return { updated: false };
    }
  }
  console.error(`[OMS] Failed to sync local portfolio after BUY fill for ${symbol} - lost the concurrency race ${MAX_SYNC_ATTEMPTS} times in a row`);
  return { updated: false };
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
