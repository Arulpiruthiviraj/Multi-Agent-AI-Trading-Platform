/**
 * FaultInjectingBroker - an order-lifecycle fault layer for the synthetic broker boundary (SYNTHETIC_SEEDED / CERTIFICATION_FIXTURE_ONLY).
 *
 * It decorates an existing BrokerAdapter INSTANCE (e.g. the simulated internal_paper / historical_replay broker) and changes only how
 * the broker REPORTS and TIMES order progress. It never creates a signal, approval or order above the broker boundary: the production
 * ChiefTrader -> RiskEngine -> sizing -> OMS path is unchanged and still decides what is submitted; this layer only makes the broker
 * misbehave the way a real one can.
 *
 * Behaviors (applied once, in FIFO order, to the next placeOrder matching the filter):
 *   DELAYED_FILL          placeOrder returns PENDING; the underlying order executes after `polls` calls to orders()/getOrderByClientOrderId (or release()).
 *   PARTIAL_THEN_FILL     first `firstQty` shares execute (PARTIALLY_FILLED reported), the remainder executes after `polls` polls (or release()).
 *   REJECT                placeOrder returns REJECTED; nothing executes.
 *   CANCEL_AFTER_ACK      placeOrder returns ACCEPTED/PENDING; the order is later reported CANCELED and NEVER executes.
 *   UNKNOWN_AFTER_SUBMIT  placeOrder THROWS a timeout-shaped error (outcome unknown). `executeUnderlying` says whether the broker really
 *                         accepted it (true: order executes and is discoverable by clientOrderId; false: it never existed).
 *   DUPLICATE_EVENT       after the order is FILLED, orders() lists it twice (a duplicated broker event).
 *   STALE_REGRESSION      after FILLED, the next orders() snapshot regresses it to PARTIALLY_FILLED once (a late/out-of-order event).
 *
 * All state is in-memory and deterministic (poll counts, not wall time).
 */
import type { Order } from './BrokerAdapter';

export type FaultBehavior =
  | { kind: 'DELAYED_FILL'; polls: number }
  | { kind: 'PARTIAL_THEN_FILL'; firstQty: number; polls: number }
  | { kind: 'REJECT' }
  | { kind: 'CANCEL_AFTER_ACK'; polls: number }
  | { kind: 'UNKNOWN_AFTER_SUBMIT'; executeUnderlying: boolean }
  | { kind: 'DUPLICATE_EVENT' }
  | { kind: 'STALE_REGRESSION' };

export interface FaultSpec { filter?: { symbol?: string; side?: 'BUY' | 'SELL' }; behavior: FaultBehavior }

interface Tracked {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  requestedQty: number;
  behavior: FaultBehavior | null;
  state: 'PENDING' | 'PARTIAL' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'NEVER_EXISTED';
  pollsRemaining: number;
  underlying: Order[]; // the real simulated-broker orders this logical order executed as
  staleServed: boolean;
}

export interface FaultInjectionController {
  /** Completes every outstanding delayed step immediately (test hook for deterministic ordering). */
  release(): Promise<void>;
  /** How many placeOrder calls actually reached the underlying broker (duplicate-exposure guard). */
  underlyingPlaceCount(): number;
  /** Logical orders as the broker sees them. */
  tracked(): Array<{ clientOrderId: string; state: string; underlyingFilledQty: number }>;
  uninstall(): void;
}

type AnyBroker = {
  placeOrder: (o: Partial<Order>) => Promise<Order>;
  orders: () => Promise<Order[]>;
  getOrderByClientOrderId?: (id: string) => Promise<Order | null>;
  cancelOrder?: (id: string) => Promise<boolean>;
};

export function installBrokerFaults(broker: AnyBroker, script: FaultSpec[]): FaultInjectionController {
  const original = {
    placeOrder: broker.placeOrder.bind(broker),
    orders: broker.orders.bind(broker),
    getOrderByClientOrderId: broker.getOrderByClientOrderId?.bind(broker),
    cancelOrder: broker.cancelOrder?.bind(broker),
  };
  const queue = [...script];
  const byClient = new Map<string, Tracked>();
  const byId = new Map<string, Tracked>();
  let underlyingPlaces = 0;
  let seq = 0;

  const place = async (o: Partial<Order>): Promise<Order> => { underlyingPlaces++; return original.placeOrder(o); };
  const filledQty = (t: Tracked) => t.underlying.reduce((s, u) => s + (u.filledQuantity ?? 0), 0);
  const avgPrice = (t: Tracked) => {
    const q = filledQty(t);
    return q > 0 ? t.underlying.reduce((s, u) => s + (u.filledQuantity ?? 0) * (u.averageFillPrice ?? 0), 0) / q : undefined;
  };
  const view = (t: Tracked, status: Order['status']): Order => ({
    id: t.id, clientOrderId: t.clientOrderId, symbol: t.symbol, side: t.side, type: 'MARKET', status,
    quantity: t.requestedQty, filledQuantity: filledQty(t), averageFillPrice: avgPrice(t), price: avgPrice(t),
    createdAt: new Date(), updatedAt: new Date(),
  } as Order);

  async function advance(t: Tracked): Promise<void> {
    const b = t.behavior;
    if (!b) return;
    if (t.state === 'PENDING' && (b.kind === 'DELAYED_FILL' || b.kind === 'PARTIAL_THEN_FILL' || b.kind === 'CANCEL_AFTER_ACK' || b.kind === 'UNKNOWN_AFTER_SUBMIT')) {
      if (b.kind === 'UNKNOWN_AFTER_SUBMIT') return; // executed (or not) at submit time
      if (t.pollsRemaining > 0) { t.pollsRemaining--; if (t.pollsRemaining > 0) return; }
      if (b.kind === 'CANCEL_AFTER_ACK') { t.state = 'CANCELED'; return; }
      if (b.kind === 'DELAYED_FILL') {
        t.underlying.push(await place({ symbol: t.symbol, side: t.side, type: 'MARKET', quantity: t.requestedQty, clientOrderId: `${t.clientOrderId}:fill` }));
        t.state = 'FILLED';
      }
      return;
    }
    if (t.state === 'PARTIAL' && b.kind === 'PARTIAL_THEN_FILL') {
      if (t.pollsRemaining > 0) { t.pollsRemaining--; if (t.pollsRemaining > 0) return; }
      t.underlying.push(await place({ symbol: t.symbol, side: t.side, type: 'MARKET', quantity: t.requestedQty - b.firstQty, clientOrderId: `${t.clientOrderId}:rest` }));
      t.state = 'FILLED';
    }
  }

  // The simulated underlying broker may itself fill asynchronously (internal_paper fills on its next tick and mutates the SAME Order object),
  // so the logical status is derived from what the underlying orders actually report, never from the scripted state alone.
  const statusOf = (t: Tracked): Order['status'] => {
    if (t.state === 'CANCELED') return 'CANCELED';
    if (t.state === 'REJECTED') return 'REJECTED';
    if (t.state === 'FILLED' || t.state === 'PARTIAL') {
      const q = filledQty(t);
      const allFilled = t.underlying.length > 0 && t.underlying.every((u) => u.status === 'FILLED');
      if (t.state === 'FILLED' && allFilled && q >= t.requestedQty - 1e-9) return 'FILLED';
      return q > 0 ? 'PARTIALLY_FILLED' : 'PENDING';
    }
    return 'PENDING';
  };

  broker.placeOrder = async (o: Partial<Order>): Promise<Order> => {
    const idx = queue.findIndex((f) => (!f.filter?.symbol || f.filter.symbol === o.symbol) && (!f.filter?.side || f.filter.side === o.side));
    if (idx < 0) { underlyingPlaces++; return original.placeOrder(o); }
    const [spec] = queue.splice(idx, 1);
    const b = spec.behavior;
    const t: Tracked = {
      id: `fault-${++seq}-${o.clientOrderId ?? 'x'}`, clientOrderId: String(o.clientOrderId ?? `fault-client-${seq}`),
      symbol: String(o.symbol), side: o.side as 'BUY' | 'SELL', requestedQty: Number(o.quantity),
      behavior: b, state: 'PENDING', pollsRemaining: 0, underlying: [], staleServed: false,
    };
    byClient.set(t.clientOrderId, t); byId.set(t.id, t);
    switch (b.kind) {
      case 'REJECT':
        t.state = 'REJECTED';
        return view(t, 'REJECTED');
      case 'DELAYED_FILL':
        t.pollsRemaining = Math.max(1, b.polls);
        return view(t, 'PENDING');
      case 'CANCEL_AFTER_ACK':
        t.pollsRemaining = Math.max(1, b.polls);
        return view(t, 'PENDING');
      case 'PARTIAL_THEN_FILL': {
        t.underlying.push(await place({ ...o, quantity: b.firstQty, clientOrderId: `${t.clientOrderId}:part1` }));
        t.state = 'PARTIAL';
        t.pollsRemaining = Math.max(1, b.polls);
        return view(t, statusOf(t));
      }
      case 'UNKNOWN_AFTER_SUBMIT': {
        if (b.executeUnderlying) {
          t.underlying.push(await place({ ...o, clientOrderId: `${t.clientOrderId}:exec` }));
          t.state = 'FILLED';
        } else {
          t.state = 'NEVER_EXISTED';
        }
        const err = new Error('BROKER_TIMEOUT: placeOrder timed out; outcome UNKNOWN (fault injection)');
        (err as Error & { code?: string }).code = 'BROKER_TIMEOUT';
        throw err;
      }
      case 'DUPLICATE_EVENT':
      case 'STALE_REGRESSION': {
        t.underlying.push(await place({ ...o, clientOrderId: `${t.clientOrderId}:exec` }));
        t.state = 'FILLED';
        return view(t, statusOf(t));
      }
    }
  };

  broker.orders = async (): Promise<Order[]> => {
    const base = await original.orders();
    const out: Order[] = [];
    // underlying orders created on behalf of logical orders are hidden behind their logical view
    const hidden = new Set<string>();
    for (const t of byClient.values()) for (const u of t.underlying) hidden.add(u.id);
    for (const o of base) if (!hidden.has(o.id)) out.push(o);
    for (const t of byClient.values()) {
      if (t.state === 'NEVER_EXISTED' || t.state === 'REJECTED') continue;
      await advance(t);
      let status = statusOf(t);
      if (t.behavior?.kind === 'STALE_REGRESSION' && t.state === 'FILLED' && !t.staleServed) {
        t.staleServed = true;
        out.push({ ...view(t, 'PARTIALLY_FILLED'), filledQuantity: Math.max(1, Math.floor(t.requestedQty / 2)) } as Order);
        continue;
      }
      out.push(view(t, status));
      if (t.behavior?.kind === 'DUPLICATE_EVENT' && t.state === 'FILLED') out.push(view(t, status));
    }
    return out;
  };

  if (original.getOrderByClientOrderId) {
    broker.getOrderByClientOrderId = async (clientOrderId: string): Promise<Order | null> => {
      const t = byClient.get(clientOrderId);
      if (!t) return original.getOrderByClientOrderId!(clientOrderId);
      if (t.state === 'NEVER_EXISTED' || t.state === 'REJECTED') return t.state === 'REJECTED' ? view(t, 'REJECTED') : null;
      await advance(t);
      return view(t, statusOf(t));
    };
  }

  if (original.cancelOrder) {
    broker.cancelOrder = async (orderId: string): Promise<boolean> => {
      const t = byId.get(orderId);
      if (!t) return original.cancelOrder!(orderId);
      if (t.state === 'PENDING' || t.state === 'PARTIAL') { t.state = t.state === 'PARTIAL' ? 'FILLED' : 'CANCELED'; return true; }
      return false;
    };
  }

  return {
    async release() {
      for (const t of byClient.values()) {
        t.pollsRemaining = 1;
        await advance(t);
        if (t.state === 'PARTIAL') { t.pollsRemaining = 1; await advance(t); }
      }
    },
    underlyingPlaceCount: () => underlyingPlaces,
    tracked: () => [...byClient.values()].map((t) => ({ clientOrderId: t.clientOrderId, state: t.state, underlyingFilledQty: filledQty(t) })),
    uninstall() {
      broker.placeOrder = original.placeOrder;
      broker.orders = original.orders;
      if (original.getOrderByClientOrderId) broker.getOrderByClientOrderId = original.getOrderByClientOrderId;
      if (original.cancelOrder) broker.cancelOrder = original.cancelOrder;
    },
  };
}
