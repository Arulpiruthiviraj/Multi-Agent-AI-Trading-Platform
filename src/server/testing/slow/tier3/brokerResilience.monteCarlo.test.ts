/**
 * Adversarial Synthetic Market & Trading Validation Framework, §37 (Large-Scale Monte Carlo
 * Synthetic Testing) - the first Tier 3 (`npm run test:tier3`) test in this repo, establishing the
 * `src/server/testing/slow/tier{3,4}/` directory convention `test:tier1` excludes. Deliberately
 * directory-based, not filename-based: an earlier version of this convention used a
 * `.monteCarlo.test.ts` filename suffix, but that collided (case-insensitive substring match) with
 * the pre-existing, unrelated, genuinely-fast `src/server/quant/analysis/MonteCarlo.test.ts` - which
 * would have silently dropped out of the default/fast CI tier. A directory boundary cannot collide
 * with an existing file's name.
 *
 * Per the framework's own instruction: "Do NOT use Monte Carlo to claim trading profitability. Use
 * it to expose system instability, sizing failures, extreme drawdowns, liquidity sensitivity, hidden
 * state bugs. Report distributions rather than only averages." This test makes no P&L/edge claim -
 * it drives InternalPaperBroker through hundreds of random, seeded, fault-injected order/price
 * sequences (via FaultInjectingBroker) and asserts structural invariants hold across the WHOLE
 * distribution, while printing the distribution (not just pass/fail) for a human to inspect.
 */
import { describe, it, expect } from 'vitest';
import { InternalPaperBroker } from '../../../../brokers/InternalPaperBroker';
import { FaultInjectingBroker } from '../../../../brokers/testing/FaultInjectingBroker';

interface RunResult {
  seed: number;
  finalCash: number;
  finalEquity: number;
  maxObservedDrawdownPct: number;
  rejectedOrderCount: number;
  acceptedOrderCount: number;
  anyNonFiniteValue: boolean;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYMBOLS = ['MCAAA', 'MCBBB', 'MCCCC'];

async function runOneScenario(seed: number): Promise<RunResult> {
  const rng = mulberry32(seed);
  const inner = new InternalPaperBroker();
  await inner.authenticate({ initialCash: 100_000 });
  const broker = new FaultInjectingBroker(inner, {
    seed,
    placeOrderRejectRate: 0.1,
    latencyMsRange: [0, 0], // Monte Carlo sweep must stay fast - latency fault covered separately
  });

  let rejectedOrderCount = 0;
  let acceptedOrderCount = 0;
  let anyNonFiniteValue = false;
  let peakEquity = 100_000;
  let maxObservedDrawdownPct = 0;
  const prices: Record<string, number> = { MCAAA: 100, MCBBB: 50, MCCCC: 200 };

  for (let step = 0; step < 60; step++) {
    // Random-walk prices - bounded away from zero, a real adversarial swing range (up to ±8%/step).
    for (const sym of SYMBOLS) {
      const move = 1 + (rng() - 0.5) * 0.16;
      prices[sym] = Math.max(0.5, prices[sym] * move);
    }
    if (rng() < 0.5) {
      const sym = SYMBOLS[Math.floor(rng() * SYMBOLS.length)];
      const side = rng() < 0.5 ? 'BUY' : 'SELL';
      const quantity = 1 + Math.floor(rng() * 50);
      try {
        await broker.placeOrder({ symbol: sym, side, type: 'MARKET', quantity });
        acceptedOrderCount += 1;
      } catch {
        rejectedOrderCount += 1;
      }
    }
    broker.tick(prices);
    const portfolio = await broker.portfolio();
    if (!Number.isFinite(portfolio.cash) || !Number.isFinite(portfolio.equity)) anyNonFiniteValue = true;
    for (const pos of portfolio.positions) {
      if (!Number.isFinite(pos.quantity) || !Number.isFinite(pos.marketValue)) anyNonFiniteValue = true;
    }
    peakEquity = Math.max(peakEquity, portfolio.equity);
    const drawdownPct = peakEquity > 0 ? ((peakEquity - portfolio.equity) / peakEquity) * 100 : 0;
    maxObservedDrawdownPct = Math.max(maxObservedDrawdownPct, drawdownPct);
  }

  const final = await broker.portfolio();
  return {
    seed,
    finalCash: final.cash,
    finalEquity: final.equity,
    maxObservedDrawdownPct,
    rejectedOrderCount,
    acceptedOrderCount,
    anyNonFiniteValue,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

describe('Monte Carlo: InternalPaperBroker + FaultInjectingBroker structural resilience (§37)', () => {
  it('across 300 random seeded scenarios, cash/equity/position math never goes non-finite and never claims a profitability result', async () => {
    const NUM_SEEDS = 300;
    const results: RunResult[] = [];
    for (let seed = 1; seed <= NUM_SEEDS; seed++) {
      results.push(await runOneScenario(seed));
    }

    const nonFiniteRuns = results.filter((r) => r.anyNonFiniteValue);
    expect(nonFiniteRuns.map((r) => r.seed)).toEqual([]); // print the exact offending seeds, per §42

    const drawdowns = results.map((r) => r.maxObservedDrawdownPct).sort((a, b) => a - b);
    const equities = results.map((r) => r.finalEquity).sort((a, b) => a - b);
    const distribution = {
      numRuns: NUM_SEEDS,
      drawdownPct: {
        p50: percentile(drawdowns, 0.5),
        p90: percentile(drawdowns, 0.9),
        p99: percentile(drawdowns, 0.99),
        max: drawdowns[drawdowns.length - 1],
      },
      finalEquity: {
        p10: percentile(equities, 0.1),
        p50: percentile(equities, 0.5),
        p90: percentile(equities, 0.9),
        min: equities[0],
        max: equities[equities.length - 1],
      },
      totalOrdersAccepted: results.reduce((a, r) => a + r.acceptedOrderCount, 0),
      totalOrdersRejected: results.reduce((a, r) => a + r.rejectedOrderCount, 0),
    };
    // eslint-disable-next-line no-console
    console.log('[Monte Carlo] broker resilience distribution (NOT a profitability claim):', JSON.stringify(distribution, null, 2));

    // Structural invariants only - never an expectancy/profitability assertion.
    expect(equities.every((e) => e >= 0)).toBe(true); // equity can never go negative in a long-only paper broker
    expect(distribution.totalOrdersRejected).toBeGreaterThan(0); // the 10% reject-rate fault actually fired at this scale
    expect(distribution.totalOrdersAccepted).toBeGreaterThan(0);
  }, 30_000);
});
