/**
 * ==========================================================
 * Module: OrderManagement.ts
 *
 * Purpose:
 * Executes broker orders safely. A placeOrder throw without a brokerOrderId is SUBMIT_UNKNOWN
 * (row stays PENDING + TRADING_PAUSED), not a fabricated REJECTED.
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
 * which point it cancels the remainder, or pauses trading if cancel is unavailable, rather than
 * abandoning a live working order. If the broker no longer reports the order at all, it logs once
 * and leaves last-known status — it never fabricates a fill the broker hasn't actually given);
 * (2) real PARTIALLY_FILLED handling that aggregates multiple
 * broker-reported fills into distinct `fills` rows (fills are additive: each apply computes the
 * *new* quantity since the last observed fill, not the cumulative total, so re-running against an
 * unchanged broker order is a safe no-op); (3) a real cancellation path
 * (`OrderManagementService.cancelOrder`) using the broker adapter's already-existing
 * `cancelOrder()`, wired to `POST /api/v2/trading/cancel-order/:id` in v2System.ts.
 * ==========================================================
 */
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { isTelemetryPulsePayload } from '../core/telemetryPulse';
import { db } from '../db';
import { trades, settings, brokerConnections } from '../db/schema';
import { eq, and, notInArray, isNotNull, inArray, isNull, gte } from 'drizzle-orm';
import crypto from 'crypto';
import { BrokerManager } from '../../brokers/BrokerManager';
import { BrokerPlugin, Order, brokerSupports } from '../../brokers/BrokerAdapter';
import { updateTransactionStatus } from '../core/TransactionRegistry';
import { tradingSafety } from '../config/tradingSafety';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { triggerWebhooks } from '../routes/webhooks';
import { resolveOmsExecutionEnvironment, stampExecutionEnvironment } from '../research/organicPaper';
import { authorizeProductionOrder } from '../core/liveOrderAuthorization';
import { resolveOmsPaperMode } from '../core/brokerEnvironment';
import { isPaperTradingOnlyEnforced, normalizeTradingMode } from '../core/tradingModeEnv';
import { getActiveReplaySession, notifyReplayOrder } from '../replay/ReplayContext';
import { releasePendingCapitalReservation } from '../engines/PendingCapitalReservations';
import { insertIncrementalFill } from './fillLedger';
import { resolvePreTradeEntryPrice } from './omsEntryPrice';
import { syncLocalPortfolioAfterSellFill, syncLocalPortfolioAfterBuyFill } from './localPortfolioSync';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';
import { isExtendedHoursExecutionEnabled } from '../config/tradingSafety';
import { resolveOrderConstruction } from '../risk/ExtendedHoursExecutionPolicy';
import { classifyMarketSession } from '../replay/marketSession';
import { TRADING_TIMEZONE } from '../core/TradingCalendar';

function getActiveReplaySessionSafe(): { replayId: string } | null {
  try {
    return getActiveReplaySession();
  } catch {
    return null;
  }
}

// Shared with TradingEngine.cancelAllOpenOrders(), which previously only matched the literal
// string 'PENDING' - real broker adapters (Alpaca) can report other non-terminal statuses
// ('NEW', 'ACCEPTED', 'PARTIALLY_FILLED', ...) that were silently excluded from that query too.
export const TERMINAL_ORDER_STATUSES: string[] = ['FILLED', 'REJECTED', 'CANCELED', 'EXTERNAL_MANUAL', 'ARCHIVED_DIAGNOSTIC'];
export function isTerminalOrderStatus(status: string | null | undefined): boolean {
  return !!status && TERMINAL_ORDER_STATUSES.includes(status);
}

// Missing/legacy-cased/malformed settings.tradingMode (no row seeded yet, stale value, etc.) must
// never surface as an un-classifiable string that cascades into BROKER_ENVIRONMENT_UNKNOWN downstream
// (classifyBrokerEnvironment only accepts exactly 'LIVE' or 'PAPER' after uppercasing) - route the raw
// DB read through the same normalizeTradingMode() fail-safe (defaults to 'PAPER', never 'LIVE') already
// used elsewhere for this exact ambiguity (tradingModeEnv.ts).
function readTradingMode(): string | null {
  try {
    const row = db.select({ tradingMode: settings.tradingMode }).from(settings).limit(1).get();
    return normalizeTradingMode(row?.tradingMode ?? null);
  } catch {
    return normalizeTradingMode(null);
  }
}

// Follow-up must not race the initial pollForFill() window (default 4s) for the same order - only
// pick up orders that window has already given up on.
const FOLLOWUP_MIN_AGE_MS = runtimeIntervals.omsFollowUpMinAgeMs;
const FOLLOWUP_MAX_AGE_MS = tradingSafety.omsFollowUpMaxAgeMs;
const FOLLOWUP_INTERVAL_MS = runtimeIntervals.omsFollowUpIntervalMs;
// Phase 1, item 3 (ARGUS_SAFETY_HARDENING_REPORT.md) - order-level crash recovery. Distinct from
// FOLLOWUP_* above: followUpOpenOrders() only ever looks at rows that already have a real
// brokerOrderId recorded - it structurally cannot help a row that crashed BEFORE that update
// landed (still PENDING with brokerOrderId=null). executeOrder() leaves those rows PENDING
// (submitOutcome=UNKNOWN) and pauses trading rather than guessing REJECTED. This runs on a
// slower cadence (order-lookup-by-client-order-id is a real broker API call per candidate
// row, not worth polling every 15s) and once immediately on start(), matching
// PortfolioReconciliation's own "runs on boot too" pattern.
const CRASH_RECOVERY_INTERVAL_MS = tradingSafety.quantCycleIntervalMs;
const CRASH_RECOVERY_LOOKBACK_MS = tradingSafety.crashRecoveryLookbackMs;

export class OrderManagementService {
  private intervalId: NodeJS.Timeout | null = null;
  private crashRecoveryIntervalId: NodeJS.Timeout | null = null;
  private followUpWarned = new Set<string>();

  constructor() {
    eventBus.on('RISK_ASSESSMENT_COMPLETED', async (assessment) => {
      // Digital Twin telemetry pulse — never placeOrder from synthetic risk pass.
      if (isTelemetryPulsePayload(assessment)) return;
      if (assessment.approved && assessment.maxQuantity > 0) {
        await this.executeOrder(assessment.symbol, assessment.side, assessment.maxQuantity, assessment.reasoning, assessment.traceId, assessment.newsDetails, assessment.transactionId, assessment.selectedQuantStrategy, assessment.quantStopPrice, assessment.quantTargetPrice, assessment.quantInvalidationJson, assessment.currentPrice);
      }
    });
  }

  private resolveFillEnvironment() {
    try {
      if (getActiveReplaySession()) return 'REPLAY';
    } catch { /* ignore */ }
    let brokerId = '';
    try {
      brokerId = BrokerManager.getInstance().getActiveBroker().id;
    } catch {
      brokerId = '';
    }
    if (brokerId === 'historical_replay') return 'REPLAY';
    return resolveOmsExecutionEnvironment({ brokerId, tradingMode: readTradingMode() });
  }

  /** Adapter id stamped onto trades.broker_id at submit (fail-closed empty → omit / unknown). */
  private resolveActiveBrokerId(): string {
    try {
      return BrokerManager.getInstance().getActiveBroker().id || '';
    } catch {
      return '';
    }
  }

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => {
      this.followUpOpenOrders().catch(e => console.error('[OMS] follow-up cycle failed', e));
    }, FOLLOWUP_INTERVAL_MS);

    if (!this.crashRecoveryIntervalId) {
      this.crashRecoveryIntervalId = setInterval(() => {
        this.reconcileStaleOrders().catch(e => console.error('[OMS] crash-recovery cycle failed', e));
        this.reconcileInboundBrokerOrders().catch(e => console.error('[OMS] inbound broker fill recovery failed', e));
      }, CRASH_RECOVERY_INTERVAL_MS);
      this.reconcileStaleOrders().catch(e => console.error('[OMS] crash-recovery startup check failed', e));
      this.reconcileInboundBrokerOrders().catch(e => console.error('[OMS] inbound broker fill recovery failed', e));
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
  private async pollForFill(broker: BrokerPlugin, orderId: string, timeoutMs = runtimeIntervals.omsPollForFillTimeoutMs, intervalMs = runtimeIntervals.omsPollForFillIntervalMs): Promise<Order | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, intervalMs));
      try {
        const orders = await broker.orders();
        const match = orders.find(o => o.id === orderId);
        if (match && match.status !== 'PENDING') return match;
      } catch (e) {
        console.warn(`[OMS] pollForFill broker.orders() failed for ${orderId}`, e);
      }
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

    try {
      const result = await insertIncrementalFill({
        orderId,
        brokerOrderId,
        requestedQuantity,
        status,
        filledQuantity,
        averageFillPrice,
      });
      if (result.newQty <= 0) return 0;
      const fillPrice = averageFillPrice || 0;
      eventBus.emit(EVENTS.ORDER_FILLED, { traceId, transactionId, id: orderId, symbol, side, quantity: result.newQty, price: fillPrice, status, filledAt: new Date().toISOString() });
      // Immediate local portfolio sync on every SELL fill increment — do not wait for the next recon tick
      // (stale localQty > 0 with broker flat → false MISSING_REMOTELY / operator pause).
      if (side === 'SELL' && result.newQty > 0) {
        await syncLocalPortfolioAfterSellFill(symbol, result.newQty);
      }
      if (side === 'BUY' && result.newQty > 0 && fillPrice > 0) {
        let brokerId: string | null = null;
        try {
          brokerId = BrokerManager.getInstance().getActiveBroker()?.id ?? null;
        } catch { /* */ }
        await syncLocalPortfolioAfterBuyFill(symbol, result.newQty, fillPrice, brokerId);
      }
      return result.newQty;
    } catch (e) {
      console.error(`[OMS] Failed to persist fill for order ${orderId}`, e);
      return 0;
    }
  }

  async executeOrder(symbol: string, side: string, quantity: number, reasoning: string, traceId: string, newsDetails?: any, transactionId?: string, quantStrategyId?: string | null, quantStopPrice?: number | null, quantTargetPrice?: number | null, quantInvalidationJson?: string | null, intendedPrice?: number | null) {
    reasoning = stampExecutionEnvironment(reasoning || '', this.resolveFillEnvironment());
    // Idempotency: refuse to place a second real order for a traceId that already has one.
    // Guards against any future duplicate RISK_ASSESSMENT_COMPLETED emission for the same trade.
    try {
      const existing = await db.select().from(trades).where(eq(trades.traceId, traceId)).limit(1);
      if (existing.length > 0) {
        console.warn(`[OMS] Duplicate execution attempt for traceId ${traceId} - an order was already placed (${existing[0].id}). Skipping.`);
        releasePendingCapitalReservation(traceId);
        try { notifyReplayOrder(traceId); } catch { /* optional */ }
        return;
      }
    } catch (e) {
      console.error('[OMS] Idempotency check failed — aborting before broker. Unique index is backup, not a license to place a second untracked order.', e);
      releasePendingCapitalReservation(traceId);
      return;
    }

    const orderId = crypto.randomUUID();
    const submittedAt = new Date().toISOString();

    // Insert the PENDING row immediately, BEFORE the broker call - this is the real submission
    // moment, not a post-hoc record of whatever happened. If this insert itself fails, there's
    // no row to update later, so abort rather than placing a real order Argus can't track.
    //
    // Unique index `idx_trades_trace_id_unique` still backs concurrent races. A failed
    // select is not fail-open: abort so a downed lookup cannot place a broker order Argus
    // cannot prove is unique.
    try {
      await db.insert(trades).values({
        id: orderId,
        symbol,
        side,
        quantity,
        price: (typeof intendedPrice === 'number' && Number.isFinite(intendedPrice) && intendedPrice > 0) ? intendedPrice : 0,
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
        quantInvalidationJson: quantInvalidationJson ?? null,
        executionEnvironment: this.resolveFillEnvironment(),
        brokerId: this.resolveActiveBrokerId() || null,
      } as any);
    } catch (e: any) {
      const isDuplicate = e?.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(String(e?.message || ''));
      if (isDuplicate) {
        console.warn(`[OMS] Duplicate execution attempt for traceId ${traceId} - blocked by the real DB unique constraint (the earlier select-based check either raced or didn't run). Skipping.`);
      } else {
        console.error('[OMS] Failed to insert initial order row - aborting before any broker call', e);
      }
      releasePendingCapitalReservation(traceId);
      return;
    }

    // The real trades row now exists - RiskEngine's own DB-backed pendingBuys query covers this
    // order from here on, so the temporary in-flight capital reservation has done its job.
    releasePendingCapitalReservation(traceId);
    eventBus.emit(EVENTS.ORDER_SUBMITTED, { traceId, transactionId, id: orderId, symbol, side, quantity, submittedAt });

    let fillPrice = 0;
    let status = "PENDING";
    let profitLoss: number | null = null;
    let brokerOrderId: string | null = null;
    let filledAt: string | null = null;

    try {
      const activeBroker = BrokerManager.getInstance().getActiveBroker();
      console.log(`[OMS] Submitting order to ${activeBroker.name}: ${side} ${quantity}x ${symbol}`);

      // Historical replay broker is always paper-sim — never LIVE. Do not depend on settings
      // dual-flag lookup (brokerConnections row may not exist for this in-memory adapter).
      const replayActive = !!getActiveReplaySessionSafe() || activeBroker.id === 'historical_replay';
      let paperMode: boolean | null = null;
      if (replayActive) {
        paperMode = true;
      } else {
        let storedPaperMode: boolean | number | null = null;
        try {
          const conn = db.select().from(brokerConnections).where(eq(brokerConnections.brokerName, activeBroker.name)).limit(1).get();
          if (conn) storedPaperMode = conn.paperMode as boolean;
        } catch {
          storedPaperMode = null;
        }
        const tradingMode = readTradingMode();
        paperMode = resolveOmsPaperMode({
          paperTradingOnly: isPaperTradingOnlyEnforced(),
          tradingMode,
          storedPaperMode,
          capabilities: activeBroker.getCapabilities?.() ?? null,
          brokerId: activeBroker.id,
        });
      }
      const envGate = authorizeProductionOrder({
        tradingMode: replayActive ? 'Paper' : readTradingMode(),
        paperMode: replayActive ? true : paperMode,
      });
      if (!envGate.ok) {
        await db.update(trades).set({
          status: 'REJECTED',
          executionEnvironment: envGate.environment === 'LIVE' ? 'LIVE' : envGate.environment === 'PAPER' ? 'PAPER' : 'UNKNOWN',
          reasoning: stampExecutionEnvironment(envGate.reason, envGate.environment === 'LIVE' ? 'LIVE' : 'UNKNOWN'),
        }).where(eq(trades.id, orderId));
        console.error(`[OMS] ${envGate.reason}`);
        // Real bug found this pass: this early return skipped the unconditional ORDER_EXECUTED
        // emit below entirely. ORDER_SUBMITTED (emitted earlier in this method) had already moved
        // the transaction to EXECUTED; without this, TransactionLifecycleTracker never saw a
        // terminal event for an env-gate rejection and the transaction stayed EXECUTED forever.
        eventBus.emitOrderExecution({
          traceId,
          transactionId,
          id: orderId,
          symbol,
          side,
          quantity,
          price: 0,
          status: 'REJECTED',
          profitLoss: null,
          executionEnvironment: envGate.environment === 'LIVE' ? 'LIVE' : envGate.environment === 'PAPER' ? 'PAPER' : 'UNKNOWN',
        });
        try { if (traceId) notifyReplayOrder(traceId); } catch { /* optional */ }
        return;
      }

      // Capture the pre-trade entry price so a SELL's realized P&L can be computed once it fills.
      // Broker positions first; on throw / missing symbol → local portfolio.averagePrice → opening BUY.
      let preTradeEntryPrice: number | null = null;
      if (side === 'SELL') {
        preTradeEntryPrice = await resolvePreTradeEntryPrice(symbol, () => activeBroker.positions());
      }

      // Phase 1 (ARGUS_SAFETY_HARDENING_REPORT.md) - orderId (this row's own local UUID, already
      // generated above and unique per real order attempt) doubles as the real broker-level
      // idempotency key. AlpacaBroker maps this to Alpaca's own `client_order_id`, which Alpaca
      // itself deduplicates on - so a timeout-triggered retry inside placeOrder() can never create
      // a second real order for this same local row, even if the first attempt actually reached
      // Alpaca and only the response was lost.
      // Session-Aware Trading Architecture Phase 5 (2026-09-05). Off by default and a no-op for
      // replay (HistoricalReplayBroker has its own, entirely separate fill-simulation semantics -
      // see HistoricalReplayBroker.ts's own header). resolveOrderConstruction() returns exactly
      // {type:'MARKET'} whenever the flag is disabled, the session is REGULAR, or no valid
      // intendedPrice is available - byte-for-byte the same order this call has always sent.
      // RiskEngine's own gate 25 (extended_hours_execution_policy) has already independently
      // evaluated the same session+flag+broker-capability+quote-freshness+spread+notional
      // checks before this order was ever approved - this is not the primary safeguard.
      const orderConstruction = replayActive
        ? ({ type: 'MARKET' } as const)
        : resolveOrderConstruction(
            classifyMarketSession(Date.now(), TRADING_TIMEZONE, true),
            intendedPrice,
            isExtendedHoursExecutionEnabled(),
          );
      const brokerOrder = await activeBroker.placeOrder({
          symbol,
          side: side as 'BUY' | 'SELL',
          quantity,
          clientOrderId: orderId,
          ...(orderConstruction.type === 'LIMIT'
            ? { type: 'LIMIT', price: orderConstruction.price, extendedHours: true }
            : { type: 'MARKET' }),
      });

      brokerOrderId = brokerOrder.id ?? null;
      status = brokerOrder.status || "REJECTED";
      if (brokerOrder.averageFillPrice) {
          fillPrice = brokerOrder.averageFillPrice;
      }

      const acceptedAt = new Date().toISOString();
      await db.update(trades).set({ brokerOrderId, status, price: fillPrice, acceptedAt }).where(eq(trades.id, orderId));
      eventBus.emit(EVENTS.ORDER_ACCEPTED, { traceId, transactionId, id: orderId, brokerOrderId, status, acceptedAt });

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

      if (side === 'SELL' && status === 'FILLED') {
        if (preTradeEntryPrice !== null && fillPrice > 0) {
          profitLoss = Number(((fillPrice - preTradeEntryPrice) * quantity).toFixed(2));
        } else {
          // Real gap this pass: a genuine FILLED SELL with no attributable P&L used to stay silently
          // null with only a console.warn (not queryable via observability_events/the dashboard).
          // Never invent a P&L figure here - just make the failure to attribute one observable.
          observeSafe(() => {
            structuredLogger.warn('pnl_attribution_failed', {
              category: 'SYSTEM',
              eventType: 'PNL_ATTRIBUTION_FAILED',
              traceId,
              decisionId: traceId,
              orderId,
              symbol,
              reason: preTradeEntryPrice === null ? 'NO_ENTRY_PRICE_RESOLVED' : 'NON_POSITIVE_FILL_PRICE',
              fillPrice,
              quantity,
            });
          });
        }
      }
      if (status === 'FILLED') {
        filledAt = new Date().toISOString();
      }
    } catch (e) {
      console.error("[OMS] Broker execution failed.", e);
      // Timeout/network throw is not a broker REJECTED. The order may have been accepted.
      // Keep PENDING, pause trading, let reconcileStaleOrders / follow-up resolve. Never retry blindly.
      if (!brokerOrderId) {
        status = 'PENDING';
        reasoning = `${reasoning} submitOutcome=UNKNOWN placeOrderThrew`;
        observeSafe(() => {
          structuredLogger.error('oms_submit_unknown', {
            category: 'BROKER',
            component: 'OMS',
            eventType: 'ORDER_SUBMIT_UNKNOWN',
            traceId,
            decisionId: traceId,
            orderId,
            symbol,
            status: 'PENDING',
            submitOutcome: 'UNKNOWN',
          });
        });
        try {
          await this.pauseTradingForOrphan(
            `OMS placeOrder threw before brokerOrderId for ${orderId}. Row stays PENDING (not REJECTED). Reconcile before any retry.`,
          );
        } catch (pauseErr) {
          console.error('[OMS] Failed to pause after unknown submit', pauseErr);
        }
      }
    }

    try {
      await db.update(trades).set({
        status,
        price: fillPrice,
        profitLoss,
        brokerOrderId,
        filledAt,
        reasoning,
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
        profitLoss,
        executionEnvironment: this.resolveFillEnvironment(),
      });

      console.log(`[OMS] Order ${orderId} finalized with status: ${status}.`);
      try { if (traceId) notifyReplayOrder(traceId); } catch { /* replay optional */ }
    } catch (error) {
      console.error(`[OMS] Failed to record order for ${symbol}:`, error);
      try { if (traceId) notifyReplayOrder(traceId); } catch { /* replay optional */ }
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
      }
      if (age > FOLLOWUP_MAX_AGE_MS && !isTerminalOrderStatus(match.status)) {
        await this.cancelOrphanedOpenOrder(row, match, broker);
      }
    }
  }

  /**
   * Orphaned open / partial orders past omsFollowUpMaxAgeMs: cancel remainder (fail-closed)
   * instead of abandoning last-known status. If cancel is unavailable or fails, pause trading.
   */
  private async pauseTradingForOrphan(reason: string): Promise<void> {
    const { getActiveReplaySession } = await import('../replay/ReplayContext');
    if (getActiveReplaySession()) {
      console.error('[OMS] Replay session active — not pausing live tradingEngine for', reason);
      return;
    }
    const { tradingEngine } = await import('../engines/TradingEngine');
    await tradingEngine.setTradingState('TRADING_PAUSED', { reason, actor: 'OrderManagement' });
  }

  private async cancelOrphanedOpenOrder(row: any, match: Order, broker: BrokerPlugin): Promise<void> {
    if (this.followUpWarned.has(row.id)) return;
    this.followUpWarned.add(row.id);
    const canCancel = brokerSupports(broker, 'canCancelOrders');
    if (!canCancel) {
      console.error(`[OMS] Orphaned ${row.status} order ${row.id} exceeded follow-up max age and broker cannot cancel — pausing trading.`);
      await this.pauseTradingForOrphan(`OMS orphaned order ${row.id} (${row.symbol}) still ${match.status} after max follow-up age; broker cannot cancel remainder.`);
      return;
    }
    try {
      await broker.cancelOrder(row.brokerOrderId);
      const refreshed = (await broker.orders()).find(o => o.id === row.brokerOrderId) || { ...match, status: 'CANCELED' };
      await this.applyFollowUpUpdate(row, refreshed);
      if (!isTerminalOrderStatus(refreshed.status)) {
        await this.pauseTradingForOrphan(`OMS cancelled orphaned order ${row.id} but broker still reports ${refreshed.status}.`);
      }
    } catch (e) {
      console.error(`[OMS] Failed to cancel orphaned order ${row.id}`, e);
      await this.pauseTradingForOrphan(`OMS failed to cancel orphaned order ${row.id} (${row.symbol}) after max follow-up age.`);
    }
  }

  /**
   * Boot/periodic: ingest FILLED/PARTIALLY_FILLED broker orders that have no local trades row
   * (crash after the broker accepted but before the local insert committed).
   */
  async reconcileInboundBrokerOrders(): Promise<void> {
    let broker: BrokerPlugin;
    try {
      broker = BrokerManager.getInstance().getActiveBroker();
    } catch {
      return;
    }
    let brokerOrders: Order[];
    try {
      brokerOrders = await broker.orders();
    } catch (e) {
      console.error('[OMS] inbound recovery: broker.orders() failed', e);
      return;
    }
    const cutoff = Date.now() - CRASH_RECOVERY_LOOKBACK_MS;
    let local: any[];
    try {
      local = await db.select().from(trades);
    } catch (e) {
      console.error('[OMS] inbound recovery: failed to read trades', e);
      return;
    }
    const byBrokerId = new Set(local.map((t: any) => t.brokerOrderId).filter(Boolean));
    const byClientId = new Set(local.map((t: any) => t.id));

    for (const o of brokerOrders) {
      const created = o.createdAt instanceof Date ? o.createdAt.getTime() : Date.parse(String(o.createdAt || 0));
      if (Number.isFinite(created) && created < cutoff) continue;
      const filledQty = o.filledQuantity ?? 0;
      if (filledQty <= 0 && o.status !== 'FILLED' && o.status !== 'PARTIALLY_FILLED') continue;
      if (byBrokerId.has(o.id)) continue;
      if (o.clientOrderId && byClientId.has(o.clientOrderId)) {
        const row = local.find((t: any) => t.id === o.clientOrderId);
        if (row) await this.applyFollowUpUpdate(row, o);
        continue;
      }
      if (filledQty <= 0) continue;
      const fillPrice = o.averageFillPrice || o.price || 0;
      if (!(fillPrice > 0)) continue;
      const nowIso = new Date().toISOString();
      const id = o.clientOrderId && !byClientId.has(o.clientOrderId) ? o.clientOrderId : crypto.randomUUID();
      try {
        // Phase 20: unrecognized broker fills are NOT RiskEngine-approved Argus orders.
        // Persist an audit row only. Do not record fills, do not update portfolio, do not
        // let PortfolioMonitor auto-manage the position.
        await db.insert(trades).values({
          id,
          symbol: o.symbol,
          side: o.side,
          quantity: o.quantity,
          price: fillPrice,
          status: 'EXTERNAL_MANUAL',
          timestamp: nowIso,
          reasoning: 'SOURCE: EXTERNAL_MANUAL. Inbound broker fill with no matching local OMS row. Not RiskEngine-approved. Operator intervention required. Argus will not auto-manage or auto-trade around this position. executionEnvironment=UNKNOWN',
          executionEnvironment: 'UNKNOWN',
          traceId: `EXTERNAL_MANUAL-${o.id}`,
          brokerOrderId: o.id,
          requestId: o.clientOrderId || id,
          submittedAt: o.createdAt instanceof Date ? o.createdAt.toISOString() : nowIso,
          filledAt: null,
          brokerId: this.resolveActiveBrokerId() || null,
        });
        console.error(`[OMS] CRITICAL SOURCE: EXTERNAL_MANUAL broker order ${o.id} (${o.side} ${filledQty} ${o.symbol}) — not ingested as an Argus fill.`);
        await triggerWebhooks({
          type: 'external_manual_order',
          title: 'External/manual broker order (not RiskEngine-approved)',
          message: `Broker order ${o.id} ${o.side} ${filledQty} ${o.symbol} has no local OMS row. Tagged SOURCE: EXTERNAL_MANUAL. Operator intervention required.`,
          details: { brokerOrderId: o.id, symbol: o.symbol, side: o.side, filledQty, source: 'EXTERNAL_MANUAL' },
        });
      } catch (e) {
        console.error(`[OMS] inbound recovery: failed to insert broker order ${o.id}`, e);
      }
    }
  }

  /**
   * Phase 1, item 3 (ARGUS_SAFETY_HARDENING_REPORT.md) - real order-level crash recovery. Finds
   * local `trades` rows with NO recorded brokerOrderId that are still PENDING (the process
   * crashed between submitting and recording the broker response, or placeOrder threw). For
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
