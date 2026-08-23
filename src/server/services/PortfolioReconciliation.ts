/**
 * ==========================================================
 * Module: PortfolioReconciliation.ts
 *
 * Purpose:
 * Syncs actual broker positions with local portfolio database.
 * ==========================================================
 */
import { db, sqliteDb } from '../db';
import { portfolio, reconciliationEvents, portfolioSnapshots, trades } from '../db/schema';
import { eq } from 'drizzle-orm';
import { BrokerManager } from '../../brokers/BrokerManager';
import { eventBus } from '../core/EventBus';
import { tradingEngine } from '../engines/TradingEngine';
import { tradingSafety } from '../config/tradingSafety';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { EVENTS } from '../core/eventNames';
import { TERMINAL_ORDER_STATUSES } from './OrderManagement';
import { submitPipelineSells } from './PipelineFlatten';
import { getActiveAcknowledgedOrderIds } from './ReconciliationAcknowledgements';
import { isReconciliationWarmupActive, reconciliationWarmupRemainingMs } from '../core/startup';
import { canonicalPortfolioSymbol, confirmConsecutiveFault, confirmMissingLocally, confirmStillHeldLocally, discrepancyFaultKey, findHolding, positionSetDelta, pruneResolvedFaults, summarizePositionSet } from './portfolioReconcileCompare';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';

const QTY_TOLERANCE = tradingSafety.reconQtyTolerance;
export const SIGNIFICANT_MISMATCH_DOLLARS = tradingSafety.reconSignificantMismatchDollars;
const ACCOUNT_CONSISTENCY_TOLERANCE_PCT = tradingSafety.reconAccountConsistencyTolerancePct;
const ACCOUNT_CONSISTENCY_TOLERANCE_FLOOR_DOLLARS = tradingSafety.reconAccountConsistencyToleranceFloorDollars;
const PAUSE_CONSECUTIVE_CYCLES = tradingSafety.reconPauseConsecutiveMismatchCycles;

interface MismatchDetail {
  symbol: string;
  type: 'QUANTITY_DRIFT' | 'MISSING_LOCALLY' | 'MISSING_REMOTELY'
      | 'OPEN_ORDER_MISSING_LOCALLY' | 'OPEN_ORDER_MISSING_REMOTELY' | 'ACCOUNT_INCONSISTENCY'
      | 'FILLED_ORDER_MISSING_LOCALLY';
  localQty: number;
  remoteQty: number;
  approxDollarImpact: number;
}

export class PortfolioReconciliationWorker {
  private intervalId: NodeJS.Timeout | null = null;
  // Hardening pass, Phase 10: reconcile() re-derives its full state (local holdings, remote
  // positions, mismatches) from scratch on every call, so a skip-if-busy guard is correct here -
  // unlike RiskEngine's evaluationQueue (where every call must eventually run), an overlapping
  // reconcile() call is fully redundant with the one already in flight and safe to drop; the next
  // scheduled 5-minute tick (or a future manual trigger) re-runs the same real check with no work
  // lost. Without this, a broker call slow enough to outlast the 5-minute interval - or any future
  // manual "reconcile now" trigger firing mid-cycle - could let two overlapping runs race on the
  // same `portfolio` table writes and double-emit RECONCILIATION_MISMATCH/MATCH.
  private isReconciling = false;
  private workerStartedAt = 0;
  /** Symbol-level MISSING_LOCALLY / MISSING_REMOTELY streaks. Cleared when that key matches. */
  private consecutiveFaults = new Map<string, number>();

  /** Test hook: shared worker singleton must not leak debounce state across cases. */
  resetFaultDebounceForTests() {
    this.consecutiveFaults.clear();
  }

  start() {
    if (this.intervalId) return;
    this.workerStartedAt = Date.now();
    this.intervalId = setInterval(() => this.reconcile(), runtimeIntervals.portfolioReconciliationMs);
    // Defer first cycle until boot warmup elapses (BrokerManager + portfolio cache settle).
    setTimeout(() => this.reconcile(), runtimeIntervals.reconciliationBootWarmupMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Broker cutover: clear local portfolio cache (never invent positions for the new adapter),
   * then reconcile against getActiveBroker().portfolio(). Does not place orders.
   */
  async flushLocalHoldingsAndReconcile(reason: string): Promise<void> {
    console.warn(`[PortfolioReconciliation] Flushing local portfolio cache (${reason})`);
    this.consecutiveFaults.clear();
    try {
      sqliteDb.prepare('DELETE FROM portfolio').run();
    } catch (e) {
      console.error('[PortfolioReconciliation] Failed to flush portfolio table', e);
    }
    await this.reconcile();
  }

  async reconcile() {
    if (this.isReconciling) {
      console.warn('[PortfolioReconciliation] A reconciliation cycle is already in progress - skipping this overlapping call.');
      return;
    }

    const brokerManager = BrokerManager.getInstance();
    if (!brokerManager.isReadyForReconciliation()) {
      console.log(`[PortfolioReconciliation] RECONCILIATION_WARMUP: broker sync state is ${brokerManager.getSyncState()} — skipping this cycle.`);
      eventBus.publish(EVENTS.RECONCILIATION_WARMUP, { reason: 'broker_not_ready', syncState: brokerManager.getSyncState() });
      return;
    }

    const warmupActive = isReconciliationWarmupActive();
    if (warmupActive) {
      console.log('[PortfolioReconciliation] RECONCILIATION_WARMUP: boot grace active — sync runs but kill-switch evaluation is suppressed.');
    }

    this.isReconciling = true;
    brokerManager.beginBrokerSync();
    try {
      console.log("[PortfolioReconciliation] Syncing local portfolio with active broker...");

      const broker = brokerManager.getActiveBroker();
      // Broker fetch FIRST, then a fresh local read. Comparing a T0 snapshot taken before
      // broker.portfolio() returns is what made concurrent hydrates look like MISSING_LOCALLY.
      const brokerPortfolio = await broker.portfolio();

      const remotePositions = brokerPortfolio.positions || [];
      // Raw SQL inside a better-sqlite3 transaction (same writer connection) — drizzle's
      // thenable query builder inside a transaction has returned a non-array, which the
      // Array.isArray guard treated as "no local positions" and flapped GLD/NVDA.
      const loadLocalHoldings = () => sqliteDb.transaction(() => {
        const rows = sqliteDb.prepare(`
          SELECT
            symbol,
            quantity,
            average_price AS averagePrice,
            current_price AS currentPrice,
            unrealized_pnl AS unrealizedPnL,
            last_updated AS lastUpdated,
            broker_source AS brokerSource
          FROM portfolio
        `).all() as Array<{
          symbol: string;
          quantity: number;
          averagePrice: number;
          currentPrice: number | null;
          unrealizedPnL: number | null;
          lastUpdated: string;
          brokerSource: string | null;
        }>;
        return Array.isArray(rows) ? rows : [];
      })();
      let localHoldings = loadLocalHoldings();
      // One retry when the broker reports names but the first WAL snapshot was empty — the
      // GLD/NVDA flap was a one-cycle empty local read, not a real missing row.
      if (remotePositions.length > 0 && localHoldings.length === 0) {
        await new Promise((r) => setTimeout(r, 20));
        localHoldings = loadLocalHoldings();
      }
      const remoteSet = summarizePositionSet(
        remotePositions.map((p: any) => ({ symbol: p.symbol, quantity: p.quantity })),
        QTY_TOLERANCE,
      );
      const localSet = summarizePositionSet(localHoldings, QTY_TOLERANCE);
      const delta = positionSetDelta(remoteSet, localSet, QTY_TOLERANCE);
      observeSafe(() => structuredLogger.info('reconciliation_position_sets', {
        category: 'RECONCILIATION',
        component: 'PortfolioReconciliation',
        metadata: { remote: remoteSet, local: localSet, delta },
      }));
      console.log(
        `[PortfolioReconciliation] sets remote=[${remoteSet.map((r) => `${r.symbol}:${r.quantity}`).join(',') || 'none'}] ` +
        `local=[${localSet.map((r) => `${r.symbol}:${r.quantity}`).join(',') || 'none'}] ` +
        `delta missingLocally=${delta.missingLocally.length} missingRemotely=${delta.missingRemotely.length} qtyDrift=${delta.qtyDrift.length}`,
      );
      // Stamp the position-compare clock HERE — not after broker.orders(). Hydrate sets
      // last_updated immediately; a slow orders() call used to stamp checkedAt ~1.7s later
      // so live rows looked like they already existed before the check.
      const positionsComparedAt = new Date().toISOString();
      const mismatches: MismatchDetail[] = [];
      const remoteCanon = new Set(remotePositions.map((p: any) => canonicalPortfolioSymbol(p.symbol)).filter(Boolean));
      const liveFaultKeys = new Set<string>();

      // Update local to match remote - the broker is always the source of truth.
      for (const pos of remotePositions) {
        const symbol = canonicalPortfolioSymbol(pos.symbol) || String(pos.symbol || '');
        const qty = pos.quantity;
        const avgPrice = pos.entryPrice;
        const price = pos.currentPrice || avgPrice;

        const local = findHolding(localHoldings, symbol);
        if (local && Math.abs((local.quantity ?? 0) - qty) <= QTY_TOLERANCE) {
          if (local.averagePrice !== avgPrice || local.currentPrice !== pos.currentPrice) {
            await db.update(portfolio).set({
              quantity: qty,
              averagePrice: avgPrice,
              currentPrice: pos.currentPrice,
              unrealizedPnL: pos.unrealizedPnl,
              lastUpdated: new Date().toISOString(),
              brokerSource: broker.id,
            }).where(eq(portfolio.symbol, local.symbol));
          }
          continue;
        }

        const verdict = await confirmMissingLocally(
          localHoldings,
          symbol,
          qty,
          QTY_TOLERANCE,
          loadLocalHoldings,
        );

        if (verdict === 'present_matching') {
          // Row landed after the in-memory snapshot (OMS/hydrate/this cycle's writer). Not a mismatch.
          console.log(`[PortfolioReconciliation] ${symbol} present on fresh local re-read — not recording MISSING_LOCALLY.`);
          continue;
        }

        if (verdict === 'present_drift' || (local && Math.abs((local.quantity ?? 0) - qty) > QTY_TOLERANCE)) {
          const localQty = (findHolding(loadLocalHoldings(), symbol)?.quantity ?? local?.quantity) ?? 0;
          console.warn(`[PortfolioReconciliation] DRIFT ${symbol}: local qty ${localQty}, broker qty ${qty} — writing broker qty (not a pause by itself).`);
          await db.update(portfolio).set({
            quantity: qty,
            averagePrice: avgPrice,
            currentPrice: pos.currentPrice,
            unrealizedPnL: pos.unrealizedPnl,
            lastUpdated: new Date().toISOString(),
            brokerSource: broker.id,
          }).where(eq(portfolio.symbol, local?.symbol ?? symbol));
          continue;
        }

        // Genuine miss: fresh query still has no row. Hydrate from this broker payload first.
        // A successful read-back means local now matches the broker — do not record MISSING_LOCALLY
        // (that MATCH/MISMATCH oscillation was GLD/NVDA every other 5-minute cycle).
        console.warn(`[PortfolioReconciliation] Broker holds ${symbol} (${qty}) with no local record after fresh re-read - hydrating.`);
        let hydrated = false;
        try {
          await db.insert(portfolio).values({
            symbol,
            quantity: qty,
            averagePrice: avgPrice,
            currentPrice: pos.currentPrice,
            unrealizedPnL: pos.unrealizedPnl,
            lastUpdated: new Date().toISOString(),
            brokerSource: broker.id,
          });
          const verify = findHolding(loadLocalHoldings(), symbol);
          if (!verify || Math.abs((verify.quantity ?? 0) - qty) > QTY_TOLERANCE) {
            observeSafe(() => structuredLogger.error('reconciliation_hydrate_verify_failed', {
              category: 'RECONCILIATION',
              component: 'PortfolioReconciliation',
              symbol,
              metadata: { expectedQty: qty, readBackQty: verify?.quantity ?? null, broker: broker.name },
            }));
            console.error(`[PortfolioReconciliation] ${symbol} insert reported success but a fresh read-back does not confirm it (expected qty ${qty}, read back ${verify?.quantity ?? 'no row'}) - see reconciliation_hydrate_verify_failed in structured logs.`);
          } else {
            hydrated = true;
          }
        } catch (insertErr) {
          const raced = findHolding(loadLocalHoldings(), symbol);
          if (raced && Math.abs((raced.quantity ?? 0) - qty) <= QTY_TOLERANCE) {
            hydrated = true;
            console.log(`[PortfolioReconciliation] ${symbol} insert raced with another writer — local already matches broker.`);
          } else {
            observeSafe(() => structuredLogger.error('reconciliation_hydrate_insert_failed', {
              category: 'RECONCILIATION',
              component: 'PortfolioReconciliation',
              symbol,
              errorMessage: insertErr instanceof Error ? insertErr.message : String(insertErr),
              metadata: { expectedQty: qty, broker: broker.name },
            }));
            console.error(`[PortfolioReconciliation] Failed to hydrate ${symbol} locally`, insertErr);
          }
        }
        if (hydrated) {
          console.log(`[PortfolioReconciliation] ${symbol} hydrated locally — not recording MISSING_LOCALLY.`);
          continue;
        }
        const faultKey = discrepancyFaultKey('MISSING_LOCALLY', symbol);
        liveFaultKeys.add(faultKey);
        if (!confirmConsecutiveFault(this.consecutiveFaults, faultKey, PAUSE_CONSECUTIVE_CYCLES)) {
          console.warn(`[PortfolioReconciliation] ${symbol} MISSING_LOCALLY deferred (${this.consecutiveFaults.get(faultKey)}/${PAUSE_CONSECUTIVE_CYCLES}) — not pausing on a one-off fetch miss.`);
          continue;
        }
        mismatches.push({ symbol, type: 'MISSING_LOCALLY', localQty: 0, remoteQty: qty, approxDollarImpact: qty * price });
      }

      // Remove locals the broker no longer holds (canonical match, not raw string equality).
      for (const local of localHoldings) {
        const localCanon = canonicalPortfolioSymbol(local.symbol);
        if (remoteCanon.has(localCanon)) continue;
        if ((local.quantity ?? 0) <= QTY_TOLERANCE) continue;
        const stillHeld = await confirmStillHeldLocally(
          localHoldings,
          localCanon || local.symbol,
          QTY_TOLERANCE,
          loadLocalHoldings,
        );
        if (!stillHeld) continue;
        const faultKey = discrepancyFaultKey('MISSING_REMOTELY', localCanon || local.symbol);
        liveFaultKeys.add(faultKey);
        if (!confirmConsecutiveFault(this.consecutiveFaults, faultKey, PAUSE_CONSECUTIVE_CYCLES)) {
          console.warn(`[PortfolioReconciliation] ${local.symbol} MISSING_REMOTELY deferred (${this.consecutiveFaults.get(faultKey)}/${PAUSE_CONSECUTIVE_CYCLES}) — not zeroing local on a one-off broker omission.`);
          continue;
        }
        const price = local.currentPrice || local.averagePrice;
        mismatches.push({ symbol: localCanon || local.symbol, type: 'MISSING_REMOTELY', localQty: local.quantity, remoteQty: 0, approxDollarImpact: local.quantity * price });
        console.warn(`[PortfolioReconciliation] Local record for ${local.symbol} (${local.quantity}) has no matching broker position - clearing it.`);
        await db.update(portfolio).set({
          quantity: 0,
          lastUpdated: new Date().toISOString()
        }).where(eq(portfolio.symbol, local.symbol));
      }
      pruneResolvedFaults(this.consecutiveFaults, liveFaultKeys);

      // Phase 1, item 4 - open-order reconciliation. Previously only positions were checked;
      // real broker orders and real cash/buying-power were entirely unreconciled (confirmed by
      // the current audit, FINAL_ANALYSIS.md Section 30.12). Compares the broker's real non-
      // terminal orders against local `trades` rows also non-terminal, matched by brokerOrderId -
      // an order on one side with no matching counterpart on the other is a real, previously
      // invisible drift (e.g. an order placed outside Argus, or a local row that never learned
      // its own broker order vanished).
      try {
        const brokerOrders = await broker.orders();
        const openBrokerOrders = brokerOrders.filter(o => !TERMINAL_ORDER_STATUSES.includes(o.status));
        const localTrades = await db.select().from(trades);
        const openLocalTrades = localTrades.filter(t => !TERMINAL_ORDER_STATUSES.includes(t.status));
        const localBrokerOrderIds = new Set(localTrades.map(t => t.brokerOrderId).filter(Boolean));
        // Operator-reviewed pre-existing fills: skip pause impact only for identical brokerOrderIds.
        const acknowledgedOrderIds = await getActiveAcknowledgedOrderIds(broker.name);

        for (const bo of openBrokerOrders) {
          const local = openLocalTrades.find(t => t.brokerOrderId === bo.id);
          if (!local) {
            const impact = (bo.price || bo.averageFillPrice || 0) * bo.quantity;
            mismatches.push({ symbol: bo.symbol, type: 'OPEN_ORDER_MISSING_LOCALLY', localQty: 0, remoteQty: bo.quantity, approxDollarImpact: impact });
            console.warn(`[PortfolioReconciliation] Broker reports an open order for ${bo.symbol} (${bo.id}) with no matching local trades row - possible order placed outside Argus.`);
          }
        }
        for (const lt of openLocalTrades) {
          if (!lt.brokerOrderId) continue; // already-crashed rows are OrderManagement.reconcileStaleOrders()'s territory, not this check's
          const remote = openBrokerOrders.find(o => o.id === lt.brokerOrderId);
          if (!remote) {
            const impact = (lt.price || 0) * lt.quantity;
            mismatches.push({ symbol: lt.symbol, type: 'OPEN_ORDER_MISSING_REMOTELY', localQty: lt.quantity, remoteQty: 0, approxDollarImpact: impact });
            console.warn(`[PortfolioReconciliation] Local trades row ${lt.id} (${lt.symbol}) is still non-terminal (${lt.status}) but ${broker.name} no longer reports order ${lt.brokerOrderId} as open.`);
          }
        }

        for (const bo of brokerOrders.filter(o => o.status === 'FILLED')) {
          if (!bo.id || localBrokerOrderIds.has(bo.id)) continue;
          if (acknowledgedOrderIds.has(bo.id)) {
            console.log(`[PortfolioReconciliation] FILLED order ${bo.id} (${bo.symbol}) is PRE_EXISTING_RECONCILED — excluded from pause impact (not organic paper).`);
            continue;
          }
          const impact = (bo.averageFillPrice || bo.price || 0) * (bo.filledQuantity || bo.quantity || 0);
          mismatches.push({ symbol: bo.symbol, type: 'FILLED_ORDER_MISSING_LOCALLY', localQty: 0, remoteQty: bo.filledQuantity || bo.quantity, approxDollarImpact: impact });
          console.warn(`[PortfolioReconciliation] Broker reports FILLED order ${bo.id} for ${bo.symbol} with no matching local trades.brokerOrderId.`);
        }
      } catch (e) {
        console.error('[PortfolioReconciliation] Open-order reconciliation failed', e);
      }

      // Phase 1, item 4 - account-level consistency check. Not a comparison against a separate
      // local ledger (none exists, by design - see the constants' own comment above), but a real
      // sanity check on the broker's own reported numbers: equity should approximately equal cash
      // plus the market value of every reported position. A real violation here means the broker
      // response itself is internally inconsistent (a stale/partial response, or a real accounting
      // problem) - not something to silently trust.
      try {
        const { cash, buyingPower, equity } = brokerPortfolio;
        const positionsValue = remotePositions.reduce((sum: number, p: any) => sum + (p.currentPrice ?? p.entryPrice ?? 0) * p.quantity, 0);
        const nonFinite = [cash, buyingPower, equity].some(v => typeof v !== 'number' || !Number.isFinite(v));
        if (nonFinite) {
          mismatches.push({ symbol: '__ACCOUNT__', type: 'ACCOUNT_INCONSISTENCY', localQty: 0, remoteQty: 0, approxDollarImpact: SIGNIFICANT_MISMATCH_DOLLARS });
          console.error(`[PortfolioReconciliation] ${broker.name} reported a non-finite cash/buyingPower/equity value: cash=${cash} buyingPower=${buyingPower} equity=${equity}`);
        } else {
          const expectedEquity = cash + positionsValue;
          const drift = Math.abs(equity - expectedEquity);
          const tolerance = Math.max(ACCOUNT_CONSISTENCY_TOLERANCE_FLOOR_DOLLARS, equity * ACCOUNT_CONSISTENCY_TOLERANCE_PCT);
          if (drift > tolerance) {
            mismatches.push({ symbol: '__ACCOUNT__', type: 'ACCOUNT_INCONSISTENCY', localQty: 0, remoteQty: 0, approxDollarImpact: drift });
            console.error(`[PortfolioReconciliation] ${broker.name}'s own reported equity ($${equity.toFixed(2)}) does not match cash+positions ($${expectedEquity.toFixed(2)}) - drift $${drift.toFixed(2)} exceeds tolerance $${tolerance.toFixed(2)}.`);
          }
        }
      } catch (e) {
        console.error('[PortfolioReconciliation] Account consistency check failed', e);
      }

      const timestamp = positionsComparedAt;
      let actionTaken: string | null = null;
      let worstImpact = 0;
      if (mismatches.length > 0) {
        worstImpact = Math.max(...mismatches.map(m => m.approxDollarImpact));
        eventBus.publish(EVENTS.RECONCILIATION_MISMATCH, { timestamp, broker: broker.name, mismatches, worstImpactDollars: Number(worstImpact.toFixed(2)) });
        // Phase 1 (ARGUS_SAFETY_HARDENING_REPORT.md) - REAL bug fixed here, found by the current
        // audit (FINAL_ANALYSIS.md Section 30.12): this used to set
        // `tradingEngine.state.emergencyStopActive = true` directly, which RiskEngine's real
        // `emergency_stop` gate never reads (it reads `tradingEngine.state.tradingState`) - so a
        // significant real position drift never actually blocked a single new order, despite this
        // code's own prior comments and the log line below claiming it did. `setTradingState()` is
        // the one real path that changes `tradingState` (persisted, audited, and the exact field
        // the gate checks) - calling it here is what actually closes the gap. TRADING_PAUSED (not
        // EMERGENCY_STOP) is used deliberately: a reconciliation drift warrants blocking NEW orders
        // pending review, not the more drastic EMERGENCY_STOP behavior of also cancelling every
        // real open order - open orders are left alone, matching the "existing positions remain
        // observable" requirement this fix was scoped against.
        const warmupActive = isReconciliationWarmupActive();
        if (warmupActive) {
          console.warn(`[PortfolioReconciliation] Boot warmup active (${reconciliationWarmupRemainingMs()}ms remaining) - mismatch recorded but TRADING_PAUSED suppressed until broker/portfolio sync stabilizes.`);
        }
        // Genuine MISSING_LOCALLY (fresh local re-read still empty) remains pause-worthy after
        // warmup. False snapshot races are not recorded above, so they cannot train operators
        // to ack-and-resume. Never auto-resume. autoFlatten stays config-false.
        if (!warmupActive && worstImpact >= SIGNIFICANT_MISMATCH_DOLLARS && tradingEngine.state.tradingState === 'TRADING_ENABLED') {
          if (tradingSafety.autoFlattenOnReconciliationMismatch) {
            const flattenSymbols = [...new Set(
              mismatches
                .filter(m => m.symbol && m.symbol !== '__ACCOUNT__' && (m.type === 'QUANTITY_DRIFT' || m.type === 'MISSING_LOCALLY' || m.type === 'MISSING_REMOTELY'))
                .map(m => m.symbol),
            )];
            if (flattenSymbols.length > 0) {
              // Flatten while still TRADING_ENABLED so RiskEngine emergency_stop can pass; then pause.
              const flattenResult = await submitPipelineSells(flattenSymbols);
              actionTaken = 'PIPELINE_FLATTEN_THEN_TRADING_PAUSED';
              console.error(`[PortfolioReconciliation] autoFlattenOnReconciliationMismatch: submitted ${flattenResult.submitted.length} SELLs via RiskEngine; refused ${flattenResult.refused.length}.`);
            }
          }
          await tradingEngine.setTradingState('TRADING_PAUSED', {
            reason: `Portfolio reconciliation found a ~$${worstImpact.toFixed(2)} mismatch vs ${broker.name} - trading paused pending manual review.`,
            actor: 'system:PortfolioReconciliation',
          });
          console.error(`[PortfolioReconciliation] SIGNIFICANT mismatch ($${worstImpact.toFixed(2)}) - trading paused (tradingState=TRADING_PAUSED) via setTradingState(), verified to actually block new orders at RiskEngine's emergency_stop gate.`);
          if (actionTaken !== 'PIPELINE_FLATTEN_THEN_TRADING_PAUSED') {
            actionTaken = 'TRADING_PAUSED';
          }
          eventBus.publish(EVENTS.RECONCILIATION_EMERGENCY_HALT, {
            timestamp,
            broker: broker.name,
            worstImpactDollars: Number(worstImpact.toFixed(2)),
            mismatches,
            autoFlatten: tradingSafety.autoFlattenOnReconciliationMismatch,
          });
        } else if (warmupActive && worstImpact >= SIGNIFICANT_MISMATCH_DOLLARS) {
          actionTaken = 'WARMUP_SUPPRESSED_PAUSE';
        }
      } else {
        eventBus.publish(EVENTS.RECONCILIATION_MATCH, { timestamp, broker: broker.name });
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

        const argusSnapshot = loadLocalHoldings();
        const snapshotRows = [
          ...argusSnapshot.map((h: any) => ({ symbol: h.symbol, quantity: h.quantity ?? 0, averagePrice: h.averagePrice, currentPrice: h.currentPrice, source: 'ARGUS', snapshotAt: timestamp, reconciliationId })),
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
    } finally {
      brokerManager.endBrokerSync();
      this.isReconciling = false;
    }
  }
}

export const portfolioReconciliationWorker = new PortfolioReconciliationWorker();
