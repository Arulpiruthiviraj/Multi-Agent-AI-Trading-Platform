/**
 * ==========================================================
 * Module: PortfolioReconciliation.ts
 *
 * Purpose:
 * Syncs actual broker positions with local portfolio database.
 * ==========================================================
 */
import { db } from '../db';
import { portfolio, reconciliationEvents, portfolioSnapshots } from '../db/schema';
import { eq } from 'drizzle-orm';
import { BrokerManager } from '../../brokers/BrokerManager';
import { eventBus } from '../core/EventBus';
import { tradingEngine } from '../engines/TradingEngine';

const QTY_TOLERANCE = 0.001; // ignore float noise, not real drift
// A mismatch this large in dollar value pauses new trading (emergencyStopActive) until reviewed -
// a small timing drift (a fill in flight when the sync runs) shouldn't halt the system, but a
// meaningfully wrong position should never be traded around silently.
const SIGNIFICANT_MISMATCH_DOLLARS = 100;

interface MismatchDetail {
  symbol: string;
  type: 'QUANTITY_DRIFT' | 'MISSING_LOCALLY' | 'MISSING_REMOTELY';
  localQty: number;
  remoteQty: number;
  approxDollarImpact: number;
}

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
    try {
      console.log("[PortfolioReconciliation] Syncing local portfolio with active broker...");

      const broker = BrokerManager.getInstance().getActiveBroker();
      const brokerPortfolio = await broker.portfolio();

      const remotePositions = brokerPortfolio.positions || [];
      const localHoldings = await db.select().from(portfolio).all();
      const mismatches: MismatchDetail[] = [];

      // Update local to match remote - the broker is always the source of truth.
      for (const pos of remotePositions) {
        const symbol = pos.symbol;
        const qty = pos.quantity;
        const avgPrice = pos.entryPrice;
        const price = pos.currentPrice || avgPrice;

        const local = localHoldings.find(h => h.symbol === symbol);
        if (local) {
          const qtyDrift = Math.abs((local.quantity ?? 0) - qty);
          if (qtyDrift > QTY_TOLERANCE) {
            mismatches.push({ symbol, type: 'QUANTITY_DRIFT', localQty: local.quantity ?? 0, remoteQty: qty, approxDollarImpact: qtyDrift * price });
            console.warn(`[PortfolioReconciliation] DRIFT ${symbol}: local qty ${local.quantity}, broker qty ${qty}`);
          }
          if (qtyDrift > QTY_TOLERANCE || local.averagePrice !== avgPrice) {
            await db.update(portfolio).set({
              quantity: qty,
              averagePrice: avgPrice,
              currentPrice: pos.currentPrice,
              unrealizedPnL: pos.unrealizedPnl,
              lastUpdated: new Date().toISOString(),
              brokerSource: broker.name,
            }).where(eq(portfolio.symbol, symbol));
          }
        } else {
          mismatches.push({ symbol, type: 'MISSING_LOCALLY', localQty: 0, remoteQty: qty, approxDollarImpact: qty * price });
          console.warn(`[PortfolioReconciliation] Broker holds ${symbol} (${qty}) with no local record - adding it.`);
          await db.insert(portfolio).values({
            symbol,
            quantity: qty,
            averagePrice: avgPrice,
            currentPrice: pos.currentPrice,
            unrealizedPnL: pos.unrealizedPnl,
            lastUpdated: new Date().toISOString(),
            brokerSource: broker.name,
          });
        }
      }

      // Remove locals the broker no longer holds.
      for (const local of localHoldings) {
        const remote = remotePositions.find((r: any) => r.symbol === local.symbol);
        if (!remote && (local.quantity ?? 0) > QTY_TOLERANCE) {
          const price = local.currentPrice || local.averagePrice;
          mismatches.push({ symbol: local.symbol, type: 'MISSING_REMOTELY', localQty: local.quantity, remoteQty: 0, approxDollarImpact: local.quantity * price });
          console.warn(`[PortfolioReconciliation] Local record for ${local.symbol} (${local.quantity}) has no matching broker position - clearing it.`);
          await db.update(portfolio).set({
            quantity: 0,
            lastUpdated: new Date().toISOString()
          }).where(eq(portfolio.symbol, local.symbol));
        }
      }

      const timestamp = new Date().toISOString();
      let actionTaken: string | null = null;
      let worstImpact = 0;
      if (mismatches.length > 0) {
        worstImpact = Math.max(...mismatches.map(m => m.approxDollarImpact));
        eventBus.publish('RECONCILIATION_MISMATCH', { timestamp, broker: broker.name, mismatches, worstImpactDollars: Number(worstImpact.toFixed(2)) });
        if (worstImpact >= SIGNIFICANT_MISMATCH_DOLLARS && !tradingEngine.state.emergencyStopActive) {
          tradingEngine.state.emergencyStopActive = true;
          tradingEngine.logHistory('veto', `Portfolio reconciliation found a ~$${worstImpact.toFixed(2)} mismatch vs ${broker.name} - trading paused pending manual review.`);
          console.error(`[PortfolioReconciliation] SIGNIFICANT mismatch ($${worstImpact.toFixed(2)}) - pausing new trading via emergencyStopActive.`);
          actionTaken = 'TRADING_PAUSED';
        }
      } else {
        eventBus.publish('RECONCILIATION_MATCH', { timestamp, broker: broker.name });
      }

      // Phase 3 (TRANSACTION_OBSERVATORY_ARCHITECTURE.md) - previously RECONCILIATION_MISMATCH/
      // MATCH were emitted live and never persisted, so there was no way to ask "how many
      // reconciliation mismatches happened last month." One row per cycle, plus a point-in-time
      // snapshot of both sides - the live `portfolio` table only ever holds current state.
      try {
        const inserted = await db.insert(reconciliationEvents).values({
          checkedAt: timestamp,
          broker: broker.name,
          matches: mismatches.length === 0,
          mismatches: mismatches.length > 0 ? JSON.stringify(mismatches) : null,
          worstImpactDollars: mismatches.length > 0 ? Number(worstImpact.toFixed(2)) : null,
          actionTaken,
        }).returning({ id: reconciliationEvents.id });
        const reconciliationId = inserted[0]?.id;

        const snapshotRows = [
          ...localHoldings.map(h => ({ symbol: h.symbol, quantity: h.quantity ?? 0, averagePrice: h.averagePrice, currentPrice: h.currentPrice, source: 'ARGUS', snapshotAt: timestamp, reconciliationId })),
          ...remotePositions.map((p: any) => ({ symbol: p.symbol, quantity: p.quantity, averagePrice: p.entryPrice, currentPrice: p.currentPrice, source: 'BROKER', snapshotAt: timestamp, reconciliationId })),
        ];
        if (snapshotRows.length > 0) {
          await db.insert(portfolioSnapshots).values(snapshotRows);
        }
      } catch (e) {
        console.error('[PortfolioReconciliation] Failed to persist reconciliation history', e);
      }

      console.log(`[PortfolioReconciliation] Sync complete. ${mismatches.length} mismatch(es).`);
    } catch (e) {
       console.error("[PortfolioReconciliation] Error during sync:", e);
    }
  }
}

export const portfolioReconciliationWorker = new PortfolioReconciliationWorker();
