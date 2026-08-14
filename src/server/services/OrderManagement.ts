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
 *
 * Phase 3 (TRANSACTION_OBSERVATORY_ARCHITECTURE.md): previously this wrote exactly one `trades`
 * row, after the broker call (and optional fill-poll) had already resolved - a trade simply
 * appeared fully-formed, with no real PENDING->ACCEPTED->FILLED transition to replay. It now
 * inserts the row immediately at submission and updates it as the broker order actually
 * progresses, emitting ORDER_SUBMITTED/ORDER_ACCEPTED/ORDER_FILLED at each real stage alongside
 * the existing ORDER_EXECUTED summary event.
 *
 * Hardening pass, Phase 2 (order lifecycle): the original design left an order behind forever if
 * it was still non-terminal after the initial ~4s poll (`pollForFill`) gave up - nothing ever
 * looked at it again, and a real PARTIALLY_FILLED status was never distinguished from a full fill
 * (only one `fills` row was ever written, for the full requested quantity, only when status was
 * literally 'FILLED'). This adds: (1) `followUpOpenOrders()`, a bounded background re-poll
 * (start()/stop() on the same interval-guarded pattern as every other periodic worker in this
 * codebase - see PortfolioMonitor.ts, ReflectionEngine.ts, etc.) that keeps checking orders the
 * initial poll gave up on, until either a terminal status is observed or a max age is reached (at
 * which point it stops polling that order and logs once - it never fabricates a resolution the
 * broker hasn't actually given); (2) real PARTIALLY_FILLED handling that aggregates multiple
 * broker-reported fills into distinct `fills` rows (fills are additive: each apply computes the
 * *new* quantity since the last observed fill, not the cumulative total, so re-running against an
 * unchanged broker order is a safe no-op); (3) a real cancellation path
 * (`OrderManagementService.cancelOrder`) using the broker adapter's already-existing
 * `cancelOrder()`, wired to `POST /api/v2/trading/cancel-order/:id` in v2System.ts.
 * ==========================================================
 */
import { eventBus } from '../core/EventBus';
import { db } from '../db';
import { trades, fills } from '../db/schema';
import { eq, and, notInArray, isNotNull, inArray, isNull, gte } from 'drizzle-orm';
import crypto from 'crypto';
import { BrokerManager } from '../../brokers/BrokerManager';
import { BrokerPlugin, Order, brokerSupports } from '../../brokers/BrokerAdapter';
import { updateTransactionStatus } from '../core/TransactionRegistry';

// Shared with TradingEngine.cancelAllOpenOrders(), which previously only matched the literal
// string 'PENDING' - real broker adapters (Alpaca) can report other non-terminal statuses
// ('NEW', 'ACCEPTED', 'PARTIALLY_FILLED', ...) that were silently excluded from that query too.
export const TERMINAL_ORDER_STATUSES: string[] = ['FILLED', 'REJECTED', 'CANCELED'];
export function isTerminalOrderStatus(status: string | null | undefined): boolean {
  return !!status && TERMINAL_ORDER_STATUSES.includes(status);
}

// Follow-up must not race the initial pollForFill() window (default 4s) for the same order - only
// pick up orders that window has already given up on.
const FOLLOWUP_MIN_AGE_MS = 6000;
// Bounded, not unbounded: stop actively re-polling (and log once) an order that's still
// non-terminal after this long - an honest "we stopped checking" signal beats silent forever-polling.
const FOLLOWUP_MAX_AGE_MS = 30 * 60 * 1000;
const FOLLOWUP_INTERVAL_MS = 15000;
// Phase 1, item 3 (ARGUS_SAFETY_HARDENING_REPORT.md) - order-level crash recovery. Distinct from
// FOLLOWUP_* above: followUpOpenOrders() only ever looks at rows that already have a real
// brokerOrderId recorded - it structurally cannot help a row that crashed BEFORE that update
// landed (still PENDING with brokerOrderId=null), or a row executeOrder()'s catch block marked
// REJECTED purely because the broker call threw (timeout/network error), with no way to know
// whether the broker actually received it first. This runs on a slower cadence (order-lookup-by-
// client-order-id is a real broker API call per candidate row, not worth polling every 15s) and
// once immediately on start(), matching PortfolioReconciliation's own "runs on boot too" pattern.
const CRASH_RECOVERY_INTERVAL_MS = 5 * 60 * 1000;
const CRASH_RECOVERY_LOOKBACK_MS = 48 * 60 * 60 * 1000; // bound the query - don't scan the whole trades table forever

export class OrderManagementService {
  private intervalId: NodeJS.Timeout | null = null;
  private crashRecoveryIntervalId: NodeJS.Timeout | null = null;
  private followUpWarned = new Set<string>();

  constructor() {
    eventBus.on('RISK_ASSESSMENT_COMPLETED', async (assessment) => {
      if (assessment.approved && assessment.maxQuantity > 0) {
        await this.executeOrder(assessment.symbol, assessment.side, assessment.maxQuantity, assessment.reasoning, assessment.traceId, assessment.newsDetails, assessment.transactionId, assessment.selectedQuantStrategy, assessment.quantStopPrice, assessment.quantTargetPrice);
      }
    });
  }

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => {
      this.followUpOpenOrders().catch(e => console.error('[OMS] follow-up cycle failed', e));
    }, FOLLOWUP_INTERVAL_MS);

    if (!this.crashRecoveryIntervalId) {
      this.crashRecoveryIntervalId = setInterval(() => {
        this.reconcileStaleOrders().catch(e => console.error('[OMS] crash-recovery cycle failed', e));
      }, CRASH_RECOVERY_INTERVAL_MS);
      this.reconcileStaleOrders().catch(e => console.error('[OMS] crash-recovery startup check failed', e));
    }
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.crashRecoveryIntervalId) {
      clearInterval(this.crashRecoveryIntervalId);
      this.crashRecoveryIntervalId = null;
    }
  }

  // InternalPaperBroker.placeOrder() only queues the order - it fills on the broker's next
  // tick() (every 1s, driven by market data). Alpaca orders can similarly settle a moment after
  // acceptance. Poll briefly for a terminal status rather than recording "PENDING" forever with
  // no fill price - never fabricates a fill; if it's still pending after the timeout, that's
  // recorded honestly (and picked up later by followUpOpenOrders()).
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

  // Computes the *new* fill quantity since the last observed fill (by summing already-recorded
  // `fills` rows for this order) and, if positive, records it as its own fills row and emits
  // ORDER_FILLED. Used both by executeOrder()'s own initial resolution and by the background
  // follow-up job, so a partial fill observed at either stage is recorded identically and
  // re-applying an unchanged broker order is always a safe no-op (newQty resolves to 0).
  private async recordFillProgress(orderId: string, brokerOrderId: string | null, traceId: string, transactionId: string | undefined, symbol: string, side: string, requestedQuantity: number, status: string, filledQuantity: number | undefined, averageFillPrice: number | undefined): Promise<number> {
    // Real broker adapters always set filledQuantity; the existing unit-test mocks (predating this
    // change) return a bare {id, status, averageFillPrice} on a full fill with no filledQuantity
    // field at all - treat a FILLED status with no explicit filledQuantity as "fully filled" to
    // preserve that established, already-tested contract exactly.
    const reportedQty = typeof filledQuantity === 'number' && filledQuantity > 0
      ? filledQuantity
      : (status === 'FILLED' ? requestedQuantity : 0);
    if (reportedQty <= 0) return 0;

    let priorQty = 0;
    try {
      const priorFills = await db.select().from(fills).where(eq(fills.orderId, orderId));
      priorQty = priorFills.reduce((sum: number, f: any) => sum + f.quantity, 0);
    } catch (e) {
      console.error(`[OMS] Failed to read prior fills for order ${orderId} - skipping fill recording to avoid double-counting`, e);
      return 0;
    }

    const newQty = reportedQty - priorQty;
    if (newQty <= 1e-9) return 0;

    const fillPrice = averageFillPrice || 0;
    await db.insert(fills).values({
      orderId,
      brokerFillId: brokerOrderId,
      quantity: newQty,
      price: fillPrice,
      filledAt: new Date().toISOString(),
    });
    eventBus.emit('ORDER_FILLED', { traceId, transactionId, id: orderId, symbol, side, quantity: newQty, price: fillPrice, status, filledAt: new Date().toISOString() });
    return newQty;
  }

  async executeOrder(symbol: string, side: string, quantity: number, reasoning: string, traceId: string, newsDetails?: any, transactionId?: string, quantStrategyId?: string | null, quantStopPrice?: number | null, quantTargetPrice?: number | null) {
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
    const submittedAt = new Date().toISOString();

    // Insert the PENDING row immediately, BEFORE the broker call - this is the real submission
    // moment, not a post-hoc record of whatever happened. If this insert itself fails, there's
    // no row to update later, so abort rather than placing a real order Argus can't track.
    //
    // Hardening pass, Phase 2: `idx_trades_trace_id_unique` (schema.ts) is the real, authoritative
    // idempotency guarantee now - the select-then-insert check above it is a check-then-act race
    // (two concurrent calls for the same traceId could both pass it before either insert lands),
    // so it's kept only as a fast-path optimization to skip an unnecessary broker call in the
    // common case; it's safe for it to fail open on a transient error, because this insert - and
    // the real DB constraint behind it - is what actually enforces "never two orders for one
    // traceId," unconditionally, even if the check above never ran or itself failed.
    try {
      await db.insert(trades).values({
        id: orderId,
        symbol,
        side,
        quantity,
        price: 0,
        status: "PENDING",
        timestamp: submittedAt,
        reasoning,
        traceId,
        transactionId,
        requestId: orderId,
        submittedAt,
        newsUsed: !!newsDetails,
        newsSentiment: newsDetails?.sentiment,
        newsConfidence: newsDetails?.confidence,
        newsSources: newsDetails?.sources,
        newsReasoning: newsDetails?.reasoning,
        // Phase 16B (ARGUS_PHASE16_READINESS_REPORT.md) - captured at the exact decision moment
        // (ChiefTraderAgent's supportingQuantDetail), null for any non-QuantEngine-sourced order.
        quantStrategyId: quantStrategyId ?? null,
        quantStopPrice: quantStopPrice ?? null,
        quantTargetPrice: quantTargetPrice ?? null,
      } as any);
    } catch (e: any) {
      const isDuplicate = e?.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(String(e?.message || ''));
      if (isDuplicate) {
        console.warn(`[OMS] Duplicate execution attempt for traceId ${traceId} - blocked by the real DB unique constraint (the earlier select-based check either raced or didn't run). Skipping.`);
      } else {
        console.error('[OMS] Failed to insert initial order row - aborting before any broker call', e);
      }
      return;
    }

    eventBus.emit('ORDER_SUBMITTED', { traceId, transactionId, id: orderId, symbol, side, quantity, submittedAt });

    let fillPrice = 0;
    let status = "PENDING";
    let profitLoss: number | null = null;
    let brokerOrderId: string | null = null;
    let filledAt: string | null = null;

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

      // Phase 1 (ARGUS_SAFETY_HARDENING_REPORT.md) - orderId (this row's own local UUID, already
      // generated above and unique per real order attempt) doubles as the real broker-level
      // idempotency key. AlpacaBroker maps this to Alpaca's own `client_order_id`, which Alpaca
      // itself deduplicates on - so a timeout-triggered retry inside placeOrder() can never create
      // a second real order for this same local row, even if the first attempt actually reached
      // Alpaca and only the response was lost.
      const brokerOrder = await activeBroker.placeOrder({
          symbol,
          side: side as 'BUY' | 'SELL',
          type: 'MARKET',
          quantity,
          clientOrderId: orderId,
      });

      brokerOrderId = brokerOrder.id ?? null;
      status = brokerOrder.status || "REJECTED";
      if (brokerOrder.averageFillPrice) {
          fillPrice = brokerOrder.averageFillPrice;
      }

      const acceptedAt = new Date().toISOString();
      await db.update(trades).set({ brokerOrderId, status, price: fillPrice, acceptedAt }).where(eq(trades.id, orderId));
      eventBus.emit('ORDER_ACCEPTED', { traceId, transactionId, id: orderId, brokerOrderId, status, acceptedAt });

      let filledQuantity = brokerOrder.filledQuantity;
      if (status === 'PENDING' && brokerOrder.id) {
        const terminal = await this.pollForFill(activeBroker, brokerOrder.id);
        if (terminal) {
          status = terminal.status;
          filledQuantity = terminal.filledQuantity;
          if (terminal.averageFillPrice) fillPrice = terminal.averageFillPrice;
        }
      }

      if (status === 'FILLED' || status === 'PARTIALLY_FILLED') {
        await this.recordFillProgress(orderId, brokerOrderId, traceId, transactionId, symbol, side, quantity, status, filledQuantity, fillPrice);
      }

      if (side === 'SELL' && status === 'FILLED' && preTradeEntryPrice !== null && fillPrice > 0) {
        profitLoss = Number(((fillPrice - preTradeEntryPrice) * quantity).toFixed(2));
      }
      if (status === 'FILLED') {
        filledAt = new Date().toISOString();
      }
    } catch (e) {
      console.error("[OMS] Broker execution failed.", e);
      status = "REJECTED";
    }

    try {
      await db.update(trades).set({
        status,
        price: fillPrice,
        profitLoss,
        brokerOrderId,
        filledAt,
      }).where(eq(trades.id, orderId));

      // transactionId was missing from this payload - the ONLY event that fires for every
      // terminal order outcome (FILLED, REJECTED, CANCELED, or still-PENDING-after-poll-timeout),
      // not just successful fills (ORDER_FILLED). Real bug found this pass: without it,
      // TransactionLifecycleTracker couldn't close out a transaction whose order was rejected or
      // canceled by the broker after risk approval. Deliberately unconditional (fires even for a
      // still-PENDING/PARTIALLY_FILLED order) - TransactionLifecycleTracker itself only treats
      // FILLED/REJECTED/CANCELED as terminal and correctly leaves a non-terminal status alone.
      eventBus.emitOrderExecution({
        traceId,
        transactionId,
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

  // Bounded background re-poll for orders executeOrder()'s own initial poll gave up on while
  // still non-terminal. Re-derives the "open" set fresh from `trades` every cycle (rather than
  // tracking in-memory) so it stays correct across restarts and never depends on this process
  // having been the one that submitted the order.
  async followUpOpenOrders(): Promise<void> {
    let openTrades: any[];
    try {
      openTrades = await db.select().from(trades)
        .where(and(notInArray(trades.status, TERMINAL_ORDER_STATUSES), isNotNull(trades.brokerOrderId)));
    } catch (e) {
      console.error('[OMS] follow-up: failed to query open trades', e);
      return;
    }
    if (openTrades.length === 0) return;

    const now = Date.now();
    const due = openTrades.filter(t => t.submittedAt && (now - new Date(t.submittedAt).getTime()) >= FOLLOWUP_MIN_AGE_MS);
    if (due.length === 0) return;

    let broker;
    try {
      broker = BrokerManager.getInstance().getActiveBroker();
    } catch (e) {
      console.error('[OMS] follow-up: no active broker', e);
      return;
    }

    let brokerOrders: Order[];
    try {
      brokerOrders = await broker.orders();
    } catch (e) {
      console.error('[OMS] follow-up: broker.orders() failed', e);
      return;
    }

    for (const row of due) {
      const age = now - new Date(row.submittedAt).getTime();
      const match = brokerOrders.find(o => o.id === row.brokerOrderId);

      if (!match) {
        if (age > FOLLOWUP_MAX_AGE_MS && !this.followUpWarned.has(row.id)) {
          console.warn(`[OMS] Giving up follow-up for order ${row.id}: broker no longer reports order ${row.brokerOrderId}. Last known status stays ${row.status}.`);
          this.followUpWarned.add(row.id);
        }
        continue;
      }

      if (match.status !== row.status || (match.filledQuantity ?? 0) > 0) {
        await this.applyFollowUpUpdate(row, match);
      } else if (age > FOLLOWUP_MAX_AGE_MS && !this.followUpWarned.has(row.id)) {
        console.warn(`[OMS] Giving up follow-up for order ${row.id} after ${Math.round(age / 1000)}s: still ${row.status}.`);
        this.followUpWarned.add(row.id);
      }
    }
  }

  /**
   * Phase 1, item 3 (ARGUS_SAFETY_HARDENING_REPORT.md) - real order-level crash recovery. Finds
   * local `trades` rows with NO recorded brokerOrderId that are either still PENDING (the process
   * crashed somewhere between submitting the order and recording the broker's response) or
   * REJECTED purely because the broker call itself threw (a timeout/network error, NOT a
   * definitive broker rejection - executeOrder()'s catch block cannot tell the difference). For
   * each, asks the broker directly "do you have a real order under this client_order_id?" - the
   * exact real-world dangerous scenario this closes: Argus sends an order, the broker accepts or
   * even fills it, Argus crashes before recording the result, and the local row is left wrong
   * forever. The broker is treated as the source of truth, exactly like PortfolioReconciliation's
   * own established philosophy for positions - never a guess from local state alone.
   */
  async reconcileStaleOrders(): Promise<void> {
    let candidates: any[];
    try {
      const cutoff = new Date(Date.now() - CRASH_RECOVERY_LOOKBACK_MS).toISOString();
      candidates = await db.select().from(trades).where(and(
        inArray(trades.status, ['PENDING', 'REJECTED']),
        isNull(trades.brokerOrderId),
        gte(trades.submittedAt, cutoff),
      ));
    } catch (e) {
      console.error('[OMS] crash-recovery: failed to query candidate trades', e);
      return;
    }
    if (candidates.length === 0) return;

    let broker: BrokerPlugin;
    try {
      broker = BrokerManager.getInstance().getActiveBroker();
    } catch (e) {
      console.error('[OMS] crash-recovery: no active broker', e);
      return;
    }
    if (typeof broker.getOrderByClientOrderId !== 'function') {
      // Honest degradation - not every broker adapter supports lookup-by-client-order-id (only
      // AlpacaBroker does today). Never fabricates a reconciliation result it can't actually check.
      return;
    }

    for (const row of candidates) {
      let realOrder: Order | null;
      try {
        realOrder = await broker.getOrderByClientOrderId(row.id);
      } catch (e) {
        console.error(`[OMS] crash-recovery: lookup failed for order ${row.id}`, e);
        continue;
      }

      if (!realOrder) {
        // Confirmed, not assumed: the broker genuinely has no record of this order. A row stuck
        // PENDING can now be safely and honestly marked REJECTED - a real answer, not a guess.
        if (row.status === 'PENDING') {
          await db.update(trades).set({ status: 'REJECTED' }).where(eq(trades.id, row.id));
          console.warn(`[OMS] crash-recovery: order ${row.id} confirmed NEVER reached ${broker.name} (real lookup by client_order_id found nothing) - marking REJECTED.`);
          if (row.transactionId) await updateTransactionStatus(row.transactionId, 'RECONCILED', { closed: true });
        }
        continue;
      }

      const realStatus = realOrder.status;
      if (realStatus !== row.status || (realOrder.filledQuantity ?? 0) > 0) {
        console.error(`[OMS] crash-recovery: order ${row.id} was locally ${row.status} (never recorded a brokerOrderId) but ${broker.name} actually has it as ${realStatus} - correcting local state. This is exactly the "crashed after send" scenario Phase 1 closes.`);

        if (realStatus === 'FILLED' || realStatus === 'PARTIALLY_FILLED') {
          await this.recordFillProgress(row.id, realOrder.id, row.traceId, row.transactionId, row.symbol, row.side, row.quantity, realStatus, realOrder.filledQuantity, realOrder.averageFillPrice);
        }

        await db.update(trades).set({
          status: realStatus,
          brokerOrderId: realOrder.id,
          price: realOrder.averageFillPrice ?? row.price,
          filledAt: realStatus === 'FILLED' ? new Date().toISOString() : row.filledAt,
        }).where(eq(trades.id, row.id));

        eventBus.emitOrderExecution({
          traceId: row.traceId,
          transactionId: row.transactionId,
          id: row.id,
          symbol: row.symbol,
          side: row.side,
          quantity: row.quantity,
          price: realOrder.averageFillPrice ?? row.price,
          status: realStatus,
          profitLoss: row.profitLoss,
        });

        if (row.transactionId) await updateTransactionStatus(row.transactionId, 'RECONCILED', { closed: true });
      }
    }
  }

  private async applyFollowUpUpdate(row: any, match: Order): Promise<void> {
    try {
      const fillPrice = match.averageFillPrice || row.price || 0;
      await this.recordFillProgress(row.id, row.brokerOrderId, row.traceId, row.transactionId, row.symbol, row.side, row.quantity, match.status, match.filledQuantity, fillPrice);

      const filledAt = match.status === 'FILLED' ? (row.filledAt || new Date().toISOString()) : row.filledAt;
      // Realized P&L for a SELL that only resolves here (past the initial poll window) can't be
      // computed honestly - the pre-trade entry-price snapshot only exists inside executeOrder()'s
      // own call stack. Left null (never fabricated) rather than guessed from current position data,
      // which may have already changed by the time this follow-up runs.
      await db.update(trades).set({
        status: match.status,
        price: fillPrice || row.price,
        filledAt,
      }).where(eq(trades.id, row.id));

      // Unconditional, matching executeOrder()'s own finalization contract - this is only ever
      // called when followUpOpenOrders() already detected a real change (a status transition or
      // new fill quantity), so every call here is a real observed transition worth broadcasting,
      // terminal or not; TransactionLifecycleTracker itself only treats FILLED/REJECTED/CANCELED
      // as terminal and correctly leaves a non-terminal status alone.
      eventBus.emitOrderExecution({
        traceId: row.traceId,
        transactionId: row.transactionId,
        id: row.id,
        symbol: row.symbol,
        side: row.side,
        quantity: row.quantity,
        price: fillPrice || row.price,
        status: match.status,
        profitLoss: row.profitLoss ?? null,
      });
    } catch (e) {
      console.error(`[OMS] follow-up: failed to apply update for order ${row.id}`, e);
    }
  }

  // Real cancellation path via the broker adapter's own cancelOrder(). Refuses cleanly (never
  // throws) for every case that isn't a genuine, broker-confirmed cancellation - an order already
  // terminal, one with no broker order id yet, or a broker whose adapter doesn't support it.
  async cancelOrder(orderId: string): Promise<{ ok: boolean; reason?: string }> {
    let row: any;
    try {
      const rows = await db.select().from(trades).where(eq(trades.id, orderId)).limit(1);
      row = rows[0];
    } catch (e) {
      return { ok: false, reason: 'Failed to look up order.' };
    }
    if (!row) return { ok: false, reason: 'Order not found.' };
    if (isTerminalOrderStatus(row.status)) return { ok: false, reason: `Order already ${row.status} - cannot cancel.` };
    if (!row.brokerOrderId) return { ok: false, reason: 'Order has no broker order id yet - cannot cancel.' };

    const broker = BrokerManager.getInstance().getActiveBroker();
    if (!brokerSupports(broker, 'canCancelOrders')) {
      return { ok: false, reason: `${broker.name} does not support order cancellation.` };
    }

    let cancelled: boolean;
    try {
      cancelled = await broker.cancelOrder(row.brokerOrderId);
    } catch (e) {
      return { ok: false, reason: 'Broker cancellation call failed.' };
    }
    if (!cancelled) return { ok: false, reason: 'Broker declined to cancel the order (it may already have filled).' };

    await db.update(trades).set({ status: 'CANCELED' }).where(eq(trades.id, orderId));
    eventBus.emitOrderExecution({
      traceId: row.traceId,
      transactionId: row.transactionId,
      id: row.id,
      symbol: row.symbol,
      side: row.side,
      quantity: row.quantity,
      price: row.price,
      status: 'CANCELED',
      profitLoss: null,
    });
    return { ok: true };
  }
}

export const oms = new OrderManagementService();
