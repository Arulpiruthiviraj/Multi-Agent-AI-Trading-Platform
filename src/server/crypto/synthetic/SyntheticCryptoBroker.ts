/**
 * ARGUS Crypto V2 - synthetic crypto broker (2026-09-21). Mechanically isolated: this file
 * imports nothing broker-related (see syntheticCryptoArchitectureBoundary.test.ts's static-scan
 * guarantee) and holds all state in an in-memory Map - there is no code path here that can reach
 * IBKR, Alpaca, or any real-money broker, because no such import exists to call through.
 *
 * Implements the order lifecycle the mandate asks for (submit/acknowledge/partial fill/full
 * fill/reject/cancel/cancel-reject/unknown-state/disconnect/reconnect/idempotency) using the same
 * shape of concepts real Argus OMS uses (clientOrderId-keyed idempotency, an immutable arrival
 * price, terminal-state no-ops) without importing OrderManagement.ts itself - a genuinely
 * separate, parallel implementation for the synthetic/isolated path only.
 */
import { SyntheticRandom } from '../../replay/synthetic/SyntheticRandom';
import { assertSyntheticSymbol } from './productionPollutionGuard';
import { simulateFill, type FillResult } from './SyntheticFillEngine';
import type { SyntheticOrderBookSnapshot } from './SyntheticOrderBook';
import type { CryptoLiquidityBucket } from './SyntheticCryptoAssetTypes';

export type SyntheticOrderStatus =
  | 'ACKNOWLEDGED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'CANCEL_REJECTED'
  | 'UNKNOWN';

export interface SyntheticOrderRequest {
  clientOrderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  arrivalPrice: number;
}

export interface SyntheticOrderRecord {
  clientOrderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  requestedQuantity: number;
  filledQuantity: number;
  remainingQuantity: number;
  status: SyntheticOrderStatus;
  readonly arrivalPrice: number;
  fills: FillResult[];
  createdAtMs: number;
  updatedAtMs: number;
}

const TERMINAL_STATUSES: ReadonlySet<SyntheticOrderStatus> = new Set(['FILLED', 'REJECTED', 'CANCELLED']);

export class SyntheticCryptoBroker {
  private readonly orders = new Map<string, SyntheticOrderRecord>();
  private readonly rng: SyntheticRandom;
  private connected = true;

  constructor(seed: number) {
    this.rng = new SyntheticRandom(seed);
  }

  simulateDisconnect(): void {
    this.connected = false;
  }

  simulateReconnect(): void {
    this.connected = true;
  }

  /** Idempotent: a second submit() with the same clientOrderId returns the ALREADY-EXISTING
   *  record unchanged, never creates a duplicate order (mandate: "must support ... idempotency"
   *  and "OMS cannot create duplicate order from duplicate submission" as a property-test
   *  invariant). */
  submit(request: SyntheticOrderRequest, nowMs: number): SyntheticOrderRecord {
    assertSyntheticSymbol(request.symbol);
    const existing = this.orders.get(request.clientOrderId);
    if (existing) return existing;

    // A disconnected broker produces a genuinely ambiguous outcome - the order MAY have reached
    // the exchange before the connection dropped. This is the real "unknown broker state" crash-
    // recovery scenario, not a rejection (mandate: "Argus cannot determine whether an order was
    // accepted").
    const status: SyntheticOrderStatus = this.connected ? 'ACKNOWLEDGED' : 'UNKNOWN';
    const record: SyntheticOrderRecord = {
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      requestedQuantity: request.quantity,
      filledQuantity: 0,
      remainingQuantity: request.quantity,
      status,
      arrivalPrice: request.arrivalPrice,
      fills: [],
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    this.orders.set(request.clientOrderId, record);
    return record;
  }

  /** No-op (returns the record unchanged) once an order has reached a terminal state - the same
   *  "duplicate market bars cannot advance an order twice" invariant the mandate asks for as a
   *  property test. */
  applyFill(
    clientOrderId: string,
    book: SyntheticOrderBookSnapshot,
    liquidityBucket: CryptoLiquidityBucket,
    volatilityMultiplier: number,
    nowMs: number,
  ): SyntheticOrderRecord {
    const order = this.orders.get(clientOrderId);
    if (!order) {
      throw new Error(`SYNTHETIC_BROKER: unknown clientOrderId "${clientOrderId}"`);
    }
    if (TERMINAL_STATUSES.has(order.status) || order.status === 'UNKNOWN') {
      return order;
    }

    const fill = simulateFill(this.rng, order.side, order.remainingQuantity, order.arrivalPrice, book, liquidityBucket, volatilityMultiplier);

    if (fill.outcome === 'REJECTED') {
      order.status = 'REJECTED';
      order.updatedAtMs = nowMs;
      return order;
    }

    order.fills.push(fill);
    order.filledQuantity += fill.fillQuantity;
    order.remainingQuantity = fill.remainingQuantity;
    order.status = order.remainingQuantity <= 1e-9 ? 'FILLED' : 'PARTIALLY_FILLED';
    order.updatedAtMs = nowMs;
    return order;
  }

  /** Cancelling a terminal order returns CANCEL_REJECTED rather than silently succeeding - the
   *  order's own prior terminal status is preserved, not overwritten. */
  cancel(clientOrderId: string, nowMs: number): SyntheticOrderRecord {
    const order = this.orders.get(clientOrderId);
    if (!order) {
      throw new Error(`SYNTHETIC_BROKER: unknown clientOrderId "${clientOrderId}"`);
    }
    if (TERMINAL_STATUSES.has(order.status)) {
      return { ...order, status: 'CANCEL_REJECTED' };
    }
    order.status = 'CANCELLED';
    order.updatedAtMs = nowMs;
    return order;
  }

  getOrder(clientOrderId: string): SyntheticOrderRecord | undefined {
    return this.orders.get(clientOrderId);
  }

  allOrders(): readonly SyntheticOrderRecord[] {
    return Array.from(this.orders.values());
  }
}
