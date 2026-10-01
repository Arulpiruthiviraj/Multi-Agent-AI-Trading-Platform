/**
 * Adversarial Synthetic Market & Trading Validation Framework, §27 (Property-Based Testing).
 *
 * 2026-09-30 audit (Explore agent survey of existing synthetic/replay/test infrastructure) found
 * Argus already has a mature synthetic-market subsystem (SyntheticMarketDataEngine, two replay
 * engines, crypto synthetic simulator, contamination-isolation guards) but ZERO property-based
 * testing anywhere in the repo - no fast-check, no equivalent. This file is the first real
 * property-based coverage, deliberately scoped to the specific §27 invariants that are (a) testable
 * against REAL production functions (never a fabricated parallel model of them) and (b) not already
 * covered by existing example-based tests elsewhere (duplicate-fill idempotency and cross-broker
 * order-binding immutability are already covered - see OrderManagement.crashRecovery.test.ts /
 * failureInjectionSuite.test.ts §4 - so they are deliberately NOT re-tested here).
 *
 * fc.assert uses a fixed seed by default only when one is supplied; on failure fast-check prints the
 * seed and a shrunk minimal counterexample to stdout - per the framework's own §42 requirement, any
 * such failure is reproducible by pinning FC_SEED (see the two `seed:` options below, derived from
 * ARGUS_FC_SEED so CI/local runs can pin a specific failure for debugging without code changes).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  classifyBrokerEnvironment,
  assertBrokerEnvironmentAllowsOrder,
} from '../core/brokerEnvironment';
import { authorizeProductionOrder } from '../core/liveOrderAuthorization';
import { gateTradeIdea } from '../core/tradeIdeaContract';
import { InternalPaperBroker } from '../../brokers/InternalPaperBroker';

const fcSeed = process.env.ARGUS_FC_SEED ? Number(process.env.ARGUS_FC_SEED) : undefined;
const numRuns = 500;

describe('Property: unknown broker environment cannot execute (classifyBrokerEnvironment)', () => {
  it('never classifies as PAPER or LIVE unless tradingMode and paperMode genuinely agree', () => {
    fc.assert(
      fc.property(
        fc.option(fc.string(), { nil: undefined }),
        fc.option(fc.oneof(fc.boolean(), fc.integer({ min: -5, max: 5 })), { nil: undefined }),
        (tradingMode, paperMode) => {
          const env = classifyBrokerEnvironment({ tradingMode, paperMode });
          if (env === 'LIVE') {
            expect(String(tradingMode || '').toUpperCase()).toBe('LIVE');
            expect(paperMode === false || paperMode === 0).toBe(true);
          }
          if (env === 'PAPER') {
            expect(String(tradingMode || '').toUpperCase()).toBe('PAPER');
            expect(paperMode === true || paperMode === 1).toBe(true);
          }
        },
      ),
      { numRuns, seed: fcSeed },
    );
  });

  it('assertBrokerEnvironmentAllowsOrder.ok is true only when the environment is PAPER or LIVE, never UNKNOWN', () => {
    fc.assert(
      fc.property(
        fc.option(fc.string(), { nil: undefined }),
        fc.option(fc.oneof(fc.boolean(), fc.integer({ min: -5, max: 5 })), { nil: undefined }),
        (tradingMode, paperMode) => {
          const result = assertBrokerEnvironmentAllowsOrder({ tradingMode, paperMode });
          if (result.ok) {
            expect(result.environment).not.toBe('UNKNOWN');
          } else {
            expect(result.environment).toBe('UNKNOWN');
          }
        },
      ),
      { numRuns, seed: fcSeed },
    );
  });
});

describe('Property: LIVE_NO_GO cannot be bypassed (authorizeProductionOrder)', () => {
  it('under PAPER_TRADING_ONLY=true, no tradingMode/paperMode combination ever authorizes a LIVE order', () => {
    const original = process.env.PAPER_TRADING_ONLY;
    process.env.PAPER_TRADING_ONLY = 'true';
    try {
      fc.assert(
        fc.property(
          fc.option(fc.string(), { nil: undefined }),
          fc.option(fc.oneof(fc.boolean(), fc.integer({ min: -5, max: 5 })), { nil: undefined }),
          (tradingMode, paperMode) => {
            const result = authorizeProductionOrder({ tradingMode, paperMode });
            if (result.environment === 'LIVE') {
              expect(result.ok).toBe(false);
              expect(result.reason).toContain('PAPER_TRADING_ONLY');
            }
          },
        ),
        { numRuns, seed: fcSeed },
      );
    } finally {
      if (original === undefined) delete process.env.PAPER_TRADING_ONLY;
      else process.env.PAPER_TRADING_ONLY = original;
    }
  });
});

describe('Property: missing/invalid price cannot pass the pre-ChiefTrader idea gate (gateTradeIdea)', () => {
  it('ok:true only ever carries a finite, positive currentPrice - never NaN/Infinity/negative/zero/non-numeric', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom('AAPL', 'MSFT', 'NVDA', 'SPY', 'not a ticker', '', '123', 'TOOLONGTICKER'),
          fc.string(),
        ),
        fc.oneof(
          fc.double({ noNaN: false, noDefaultInfinity: false }),
          fc.constantFrom(NaN, Infinity, -Infinity, 0, -1, null, undefined, '', 'abc', '42.5', '-5'),
          fc.string(),
        ),
        (symbol, currentPrice) => {
          const result = gateTradeIdea({ symbol, currentPrice });
          if (result.ok) {
            expect(Number.isFinite(result.idea.currentPrice)).toBe(true);
            expect(result.idea.currentPrice).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns, seed: fcSeed },
    );
  });
});

describe('Property: InternalPaperBroker never produces NaN cash or NaN/negative position state', () => {
  it('under a random sequence of orders and price ticks, cash/position quantity/marketValue stay finite, and cash never goes negative', async () => {
    const symbols = ['PQAAA', 'PQBBB', 'PQCCC'];
    const orderArb = fc.record({
      symbol: fc.constantFrom(...symbols),
      side: fc.constantFrom<'BUY' | 'SELL'>('BUY', 'SELL'),
      type: fc.constantFrom<'MARKET' | 'LIMIT'>('MARKET', 'LIMIT'),
      quantity: fc.integer({ min: 1, max: 500 }),
      price: fc.double({ min: 0.01, max: 5000, noNaN: true, noDefaultInfinity: true }),
    });
    const tickArb = fc.record(
      Object.fromEntries(symbols.map((s) => [s, fc.double({ min: 0.01, max: 5000, noNaN: true, noDefaultInfinity: true })])),
    );
    // Interleaved sequence of "place an order" / "advance the tick clock" steps - a real
    // adversarial sequence, not just isolated single-order scenarios.
    const stepArb = fc.array(
      fc.oneof(
        fc.record({ kind: fc.constant<'order'>('order'), order: orderArb }),
        fc.record({ kind: fc.constant<'tick'>('tick'), prices: tickArb }),
      ),
      { minLength: 1, maxLength: 40 },
    );

    await fc.assert(
      fc.asyncProperty(stepArb, async (steps) => {
        const broker = new InternalPaperBroker();
        await broker.authenticate({ initialCash: 100_000 });
        for (const step of steps) {
          if (step.kind === 'order') {
            await broker.placeOrder(step.order);
          } else {
            broker.tick(step.prices as Record<string, number>);
          }
        }
        const portfolio = await broker.portfolio();
        expect(Number.isFinite(portfolio.cash)).toBe(true);
        expect(Number.isFinite(portfolio.equity)).toBe(true);
        expect(portfolio.cash).toBeGreaterThanOrEqual(0); // BUY is refused, never allowed to overdraw
        for (const pos of portfolio.positions) {
          expect(Number.isFinite(pos.quantity)).toBe(true);
          expect(pos.quantity).toBeGreaterThan(0); // a closed-out position is deleted, never left at 0/negative
          expect(Number.isFinite(pos.entryPrice)).toBe(true);
          expect(Number.isFinite(pos.marketValue)).toBe(true);
          expect(Number.isFinite(pos.unrealizedPnl)).toBe(true);
        }
      }),
      { numRuns: 200, seed: fcSeed },
    );
  });
});
