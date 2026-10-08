/**
 * brokerMemory.ts - bounded in-memory hygiene for the broker/OMS subsystem.
 *
 * 2026-10-08 memory-leak hunt (RISK/OMS/FILLS/BROKER): several in-memory structures in
 * this subsystem grew by one entry per order for process lifetime because terminal
 * (FILLED/REJECTED/CANCELED) state was never removed:
 *   - InternalPaperBroker._orders / CryptoPaperBroker._orders (+ _clientOrderIdIndex,
 *     triggeredStops): every paper order left a registry entry forever.
 *   - OrderManagementService.followUpWarned / unknownPendingOrderWarned: warn-once Sets
 *     keyed by order id, one string per warned order, never cleared.
 *
 * Fixes here bound them without changing order-lifecycle semantics:
 *   - Order registries: only TERMINAL orders are ever evicted, oldest-first, only when
 *     over the cap. Non-terminal orders are never evicted regardless of size (OMS
 *     follow-up, crash recovery lookups, PortfolioReconciliation, and the
 *     unacked-filled-orphans diagnostic all depend on them). Terminal history stays in
 *     the trades/fills DB rows; the registry is a working-set cache, not the record.
 *   - Warn-once sets: insertion-ordered FIFO registry - warn-once semantics hold for the
 *     working set; only long-gone ancient entries lose their remembered warning.
 *
 * Tuning (env; config/*.json untouched per hunt rules):
 *   ARGUS_PAPER_BROKER_ORDER_REGISTRY_MAX - registry cap, default 5000. Ignored unless
 *     a positive integer.
 *   ARGUS_PAPER_BROKER_ORDER_EVICTION - set to 'false' to disable eviction entirely
 *     (registries return to unbounded; intended only for forensic debugging).
 *   ARGUS_OMS_WARN_ONCE_MAX - warn-once registry cap, default 1000.
 */
import type { Order } from './BrokerAdapter';

export const DEFAULT_PAPER_BROKER_ORDER_REGISTRY_MAX_ENTRIES = 5000;
export const DEFAULT_OMS_WARN_ONCE_MAX_ENTRIES = 1000;

/** Positive-integer env override, else the compiled default. */
function resolvePositiveIntEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

export function resolvePaperBrokerOrderRegistryMax(): number {
  return resolvePositiveIntEnv('ARGUS_PAPER_BROKER_ORDER_REGISTRY_MAX', DEFAULT_PAPER_BROKER_ORDER_REGISTRY_MAX_ENTRIES);
}

export function isPaperBrokerOrderEvictionEnabled(): boolean {
  return process.env.ARGUS_PAPER_BROKER_ORDER_EVICTION !== 'false';
}

export function resolveOmsWarnOnceMax(): number {
  return resolvePositiveIntEnv('ARGUS_OMS_WARN_ONCE_MAX', DEFAULT_OMS_WARN_ONCE_MAX_ENTRIES);
}

/** Terminal states a paper-broker adapter can report. Never evict anything else. */
export function isTerminalBrokerOrderStatus(status: string | null | undefined): boolean {
  return status === 'FILLED' || status === 'CANCELED' || status === 'REJECTED';
}

interface TerminalOrderLike {
  id: string;
  status: string;
  updatedAt: Date;
}

/**
 * Evicts oldest-terminal-first until the registry is at most maxEntries. Returns the number
 * evicted. Never touches non-terminal orders. `onEvict` lets the caller drop coherent
 * auxiliary state (indexes keyed off the evicted order).
 */
export function evictOldestTerminalOrdersIfOverCap<T extends TerminalOrderLike>(
  orders: Map<string, T>,
  maxEntries: number,
  onEvict?: (order: T) => void,
): number {
  if (orders.size <= maxEntries) return 0;
  const terminal = [...orders.values()]
    .filter((o) => isTerminalBrokerOrderStatus(o.status))
    .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
  let overBy = orders.size - maxEntries;
  let evicted = 0;
  for (const order of terminal) {
    if (overBy <= 0) break;
    orders.delete(order.id);
    onEvict?.(order);
    overBy--;
    evicted++;
  }
  return evicted;
}

export type { Order };

/**
 * Bounded warn-once registry (insertion-ordered FIFO). `add` returns true the first time an
 * id is seen, false afterwards - the same contract as the unbounded Sets this replaces.
 * When over capacity, the oldest-remembered ids are forgotten first.
 */
export class BoundedWarnOnce {
  private seen = new Map<string, number>();
  private readonly max: number;

  constructor(max?: number) {
    this.max = max ?? resolveOmsWarnOnceMax();
  }

  /** true if this id was already warned for (no new warning needed). */
  has(id: string): boolean {
    return this.seen.has(id);
  }

  /**
   * Records a warning for id. Returns true if a warning should be emitted now
   * (first sighting), false if it was already warned for.
   */
  warn(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.set(id, 1);
    if (this.seen.size > this.max) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}
