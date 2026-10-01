/**
 * Adversarial Synthetic Market & Trading Validation Framework, §18 (Broker Failure Simulator).
 *
 * 2026-09-30 audit finding: InternalPaperBroker has zero built-in fault injection, and every
 * existing broker-failure test in this codebase (IbkrSocketSession.*.test.ts,
 * failureInjectionSuite.test.ts) hand-mocks the specific real adapter's specific method per file -
 * there is no single reusable "chaos broker" double. This wraps any real BrokerPlugin (real
 * InternalPaperBroker by default, or any other adapter) with deterministic, seeded fault injection
 * at the BrokerPlugin interface boundary, so a scenario test can drive a REAL broker through failure
 * modes instead of constructing a bespoke mock every time.
 *
 * Test-only. Never imported by any production module (see
 * faultInjectingBrokerArchitectureBoundary.test.ts) and never wraps a broker whose
 * getCapabilities().liveTrading is true, so a LIVE account can never be driven through this class.
 */
// @ts-nocheck

import type { BrokerPlugin, BrokerCapabilities, Order, Portfolio, Position } from '../BrokerAdapter';

/** Deterministic PRNG (mulberry32) - never Math.random(), so a failure is reproducible from `seed`
 *  alone, per the framework's own §42 reproducibility requirement. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class BrokerFaultInjectedError extends Error {
  constructor(public readonly faultKind: string, message: string) {
    super(message);
    this.name = 'BrokerFaultInjectedError';
  }
}

export interface FaultInjectionConfig {
  /** RNG seed - same seed + same call sequence always reproduces the same faults. */
  seed: number;
  /** Fraction (0-1) of placeOrder() calls that reject outright (simulates a real broker rejection,
   *  e.g. contract-not-found / insufficient-funds at the venue). Default 0 (no rejection faults). */
  placeOrderRejectRate?: number;
  /** Fraction (0-1) of placeOrder() calls that return a real-looking PARTIALLY_FILLED order instead
   *  of whatever the wrapped broker actually returned - a deliberately simplified, test-only partial
   *  fill (never a claim this reproduces a real venue's partial-fill matching logic; use
   *  HistoricalReplayBroker for that). Only fires when the WRAPPED broker's placeOrder() itself
   *  returns FILLED synchronously - InternalPaperBroker never does (its fills happen later, on
   *  tick()), so this fault is a no-op when wrapping it. Default 0. */
  partialFillRate?: number;
  /** Any call at or after this 1-indexed global call count throws a simulated disconnect
   *  (BrokerFaultInjectedError) instead of reaching the wrapped broker at all. Undefined = never. */
  disconnectAfterCallCount?: number;
  /** Artificial latency window [minMs, maxMs] applied before every call resolves (0 default = no
   *  injected latency). Useful for ack-timeout-style scenarios (§18) when combined with a caller's
   *  own timeout. */
  latencyMsRange?: [number, number];
}

/**
 * Wraps a real BrokerPlugin with deterministic, seeded fault injection. Every method is a
 * pass-through to `inner` except where a fault is configured to fire - this is a decorator, not a
 * reimplementation, so the wrapped broker's real behavior (real accounting, real position math for
 * InternalPaperBroker) is exercised exactly as it would be in production up to the injected fault.
 */
export class FaultInjectingBroker implements BrokerPlugin {
  readonly id: string;
  readonly name: string;
  private readonly rng: () => number;
  private callCount = 0;

  constructor(private readonly inner: BrokerPlugin, private readonly config: FaultInjectionConfig) {
    if (inner.getCapabilities().liveTrading) {
      throw new Error('FaultInjectingBroker refuses to wrap a broker whose capabilities report liveTrading=true - test-only, never LIVE.');
    }
    this.id = `fault_injected_${inner.id}`;
    this.name = `Fault-Injected ${inner.name}`;
    this.rng = mulberry32(config.seed);
  }

  private async beforeCall(): Promise<void> {
    this.callCount += 1;
    if (this.config.disconnectAfterCallCount != null && this.callCount >= this.config.disconnectAfterCallCount) {
      throw new BrokerFaultInjectedError('DISCONNECT', `Simulated disconnect at call #${this.callCount} (seed=${this.config.seed}).`);
    }
    const [minMs, maxMs] = this.config.latencyMsRange ?? [0, 0];
    if (maxMs > 0) {
      const delay = minMs + this.rng() * (maxMs - minMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  async initialize(): Promise<void> { await this.beforeCall(); return this.inner.initialize(); }
  async authenticate(credentials: any): Promise<boolean> { await this.beforeCall(); return this.inner.authenticate(credentials); }
  async validateCredentials(): Promise<boolean> { await this.beforeCall(); return this.inner.validateCredentials(); }
  paperTrading(): void { this.inner.paperTrading(); }
  liveTrading(): void { this.inner.liveTrading(); }
  getCapabilities(): BrokerCapabilities { return { ...this.inner.getCapabilities(), liveTrading: false }; }
  async portfolio(): Promise<Portfolio> { await this.beforeCall(); return this.inner.portfolio(); }
  async orders(): Promise<Order[]> { await this.beforeCall(); return this.inner.orders(); }
  async positions(): Promise<Position[]> { await this.beforeCall(); return this.inner.positions(); }
  async account(): Promise<any> { await this.beforeCall(); return this.inner.account(); }
  async disconnect(): Promise<void> { await this.beforeCall(); return this.inner.disconnect(); }
  async health(): Promise<string> { await this.beforeCall(); return this.inner.health(); }

  async placeOrder(order: Partial<Order>): Promise<Order> {
    await this.beforeCall();
    const rejectRate = this.config.placeOrderRejectRate ?? 0;
    if (rejectRate > 0 && this.rng() < rejectRate) {
      throw new BrokerFaultInjectedError('PLACE_ORDER_REJECTED', `Simulated broker rejection for ${order.symbol} (seed=${this.config.seed}, call=${this.callCount}).`);
    }
    const real = await this.inner.placeOrder(order);
    const partialRate = this.config.partialFillRate ?? 0;
    if (partialRate > 0 && real.status === 'FILLED' && this.rng() < partialRate) {
      const partialQty = Math.max(1, Math.floor(real.quantity * (0.2 + this.rng() * 0.6)));
      return {
        ...real,
        status: 'PARTIALLY_FILLED',
        filledQuantity: partialQty,
      };
    }
    return real;
  }

  async cancelOrder(orderId: string): Promise<boolean> { await this.beforeCall(); return this.inner.cancelOrder(orderId); }
  async closePosition(symbol: string): Promise<boolean> { await this.beforeCall(); return this.inner.closePosition(symbol); }
  tick(currentPrices: Record<string, number>): void { this.inner.tick?.(currentPrices); }
  async getOrderByClientOrderId(clientOrderId: string): Promise<Order | null> {
    await this.beforeCall();
    return this.inner.getOrderByClientOrderId ? this.inner.getOrderByClientOrderId(clientOrderId) : null;
  }
}
