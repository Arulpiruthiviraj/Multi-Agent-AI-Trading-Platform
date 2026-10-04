/**
 * Property test for the global close-long invariant introduced by the 2026-10-03 fill-backed
 * inventory remediation (docs/architecture/ARGUS_ARCHITECTURE.md § "2026-10-03: fill-backed
 * inventory and forensic remediation", migration `0082_position_fill_evidence`).
 *
 * The OKTA incident (2026-10-01, see
 * docs/audits/ARGUS_THURSDAY_FRIDAY_TRADING_FORENSIC_2026-10-01_2026-10-02.md) and its fix
 * (`OrderManagement.positionEvidence.test.ts`, 8 example-based scenarios including a direct replay
 * of the historical sequence) are both real and already passing. What is still missing, and what
 * this file adds, is the §27/§40-style property check across *randomly generated* adversarial
 * sequences rather than a fixed set of hand-picked examples - run against the REAL
 * `prepareOrderPosition`/`applyPositionFill`/`insertIncrementalFill` production functions (never a
 * fabricated parallel model of them), per this repo's existing propertyInvariants.test.ts convention.
 *
 * Global invariant under test: a CLOSE_LONG-only flow (BUY then SELL through this module) can never
 * drive the fill-ledger-confirmed position negative, and cumulative recorded SELL fill quantity can
 * never exceed cumulative recorded BUY fill quantity for the same scope - regardless of what
 * "remote quantity" (simulating a stale, correct, zero, or adversarially wrong broker snapshot) is
 * presented to `prepareOrderPosition` at each SELL attempt. There is no OPEN_SHORT path in this
 * module (`prepareOrderPosition` has no mechanism to authorize one), so this is specifically a
 * no-oversell / no-sign-flip property, not a claim that shorting is impossible everywhere in Argus.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import { db, sqliteDb } from '../db';
import { trades, fills, portfolio } from '../db/schema';
import { prepareOrderPosition } from './positionFillEvidence';
import { insertIncrementalFill } from './fillLedger';

const fcSeed = process.env.ARGUS_FC_SEED ? Number(process.env.ARGUS_FC_SEED) : undefined;
const BROKER_ID = 'property_fixture_broker';
const ENVIRONMENT = 'REPLAY';
const SYMBOL = 'PROPOKTA';

beforeAll(() => { expect(process.env.ARGUS_DB_PATH).toContain('argus_test_'); });

beforeEach(async () => {
  await db.delete(fills);
  await db.delete(trades);
  await db.delete(portfolio);
});
afterEach(async () => {
  await db.delete(fills);
  await db.delete(trades);
  await db.delete(portfolio);
});

/** Submits one order through the real guard + real fill-ledger transaction, mirroring exactly what
 * OrderManagement.ts does at its call site (prepareOrderPosition immediately before the broker
 * submission, then insertIncrementalFill on a synchronous full fill). Returns whether it was
 * accepted and, if so, whether the fill-ledger transaction itself then also accepted it (a second,
 * independent gate: `order.quantity > quantity` is already blocked by prepareOrderPosition, but
 * insertIncrementalFill has its own independent reportedQty > requestedQuantity guard). */
async function attemptOrder(side: 'BUY' | 'SELL', quantity: number, remoteQuantity: number, price: number) {
  const id = randomUUID();
  await db.insert(trades).values({
    id, traceId: id, symbol: SYMBOL, side, quantity, price: 0, status: 'PENDING',
    timestamp: new Date().toISOString(), brokerId: BROKER_ID, executionEnvironment: ENVIRONMENT,
  });
  const refusal = prepareOrderPosition(id, { quantity: remoteQuantity, entryPrice: price });
  if (refusal) {
    sqliteDb.prepare('UPDATE trades SET status=?, reasoning=? WHERE id=?').run('REJECTED', refusal, id);
    return { accepted: false, refusal };
  }
  try {
    await insertIncrementalFill({
      orderId: id, brokerOrderId: null, requestedQuantity: quantity, status: 'FILLED',
      filledQuantity: quantity, averageFillPrice: price, applyPosition: true,
    });
    sqliteDb.prepare('UPDATE trades SET status=?, price=? WHERE id=?').run('FILLED', price, id);
    return { accepted: true, refusal: null };
  } catch (e) {
    // insertIncrementalFill's own independent validation refused a malformed fill (e.g. the
    // generator produced a fill quantity exceeding the order's requested quantity). The order
    // never reaches FILLED; this is a second, independent layer catching what prepareOrderPosition
    // does not itself re-validate (it only bounds order.quantity against *position*, not against
    // the later reported fill quantity).
    sqliteDb.prepare('UPDATE trades SET status=? WHERE id=?').run('RECONCILIATION_REQUIRED', id);
    return { accepted: false, refusal: 'FILL_LEDGER_REJECTED' };
  }
}

function currentPortfolioQuantity(): number {
  const row = sqliteDb.prepare('SELECT quantity FROM portfolio WHERE symbol=?').get(SYMBOL) as { quantity: number } | undefined;
  return row?.quantity ?? 0;
}

function cumulativeFilledSide(side: 'BUY' | 'SELL'): number {
  const row = sqliteDb.prepare(
    `SELECT COALESCE(SUM(f.quantity),0) AS total FROM fills f JOIN trades t ON t.id=f.order_id
     WHERE t.symbol=? AND t.side=? AND t.status='FILLED'`,
  ).get(SYMBOL, side) as { total: number };
  return row.total;
}

describe('Property: close-long flows through positionFillEvidence can never oversell or flip sign', () => {
  it('never lets cumulative FILLED SELL quantity exceed cumulative FILLED BUY quantity, for any adversarial remote-quantity sequence', async () => {
    // Each step is one order attempt. `staleness` models what a broker snapshot read immediately
    // before submission reported, resolved against the REAL current quantity at run time (not
    // generated independently of it) so the adversarial cases are the realistic ones: a perfectly
    // fresh read, a stale read one step behind (the OKTA mechanism - reports a quantity this scope
    // held *before* its most recent fill), a stale-zero read, or an arbitrary wrong value.
    const stepArb = fc.record({
      side: fc.constantFrom<'BUY' | 'SELL'>('BUY', 'SELL'),
      quantity: fc.integer({ min: 1, max: 50 }),
      staleness: fc.constantFrom<'FRESH' | 'STALE_PRIOR' | 'STALE_ZERO' | 'GARBAGE'>(
        'FRESH', 'STALE_PRIOR', 'STALE_ZERO', 'GARBAGE'),
      garbageOffset: fc.integer({ min: -20, max: 20 }),
      price: fc.double({ min: 1, max: 1000, noNaN: true, noDefaultInfinity: true }),
    });
    const sequenceArb = fc.array(stepArb, { minLength: 1, maxLength: 15 });

    await fc.assert(
      fc.asyncProperty(sequenceArb, async (steps) => {
        await db.delete(fills); await db.delete(trades); await db.delete(portfolio);
        let priorQuantity = 0;
        for (const step of steps) {
          const actual = currentPortfolioQuantity();
          const remoteQuantity = step.staleness === 'FRESH' ? actual
            : step.staleness === 'STALE_PRIOR' ? priorQuantity
            : step.staleness === 'STALE_ZERO' ? 0
            : actual + step.garbageOffset;
          priorQuantity = actual;
          await attemptOrder(step.side, step.quantity, remoteQuantity, step.price);
          // Invariant checked after EVERY step, not just at the end: at no point in an adversarial
          // sequence may the fill-ledger-tracked position go negative, and cumulative SELL fills
          // may never exceed cumulative BUY fills - this is exactly the property that failed for
          // real on 2026-10-01 (a second SELL filled against a stale +14 after the position was
          // already flat, driving the broker-backed position to -14).
          expect(currentPortfolioQuantity()).toBeGreaterThanOrEqual(0);
          expect(cumulativeFilledSide('SELL')).toBeLessThanOrEqual(cumulativeFilledSide('BUY'));
        }
      }),
      { numRuns: 300, seed: fcSeed },
    );
  });

  it('refuses a SELL whose remote quantity disagrees with the fill-ledger watermark even when it would otherwise be a legal partial close', async () => {
    // Deliberately replays the OKTA shape at random quantities: BUY N, SELL all N (flat), then a
    // second SELL presented with a stale remoteQuantity equal to the original N. The second SELL
    // must never be accepted, for any N and any stale price.
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 100 }),
        fc.double({ min: 1, max: 1000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 1, max: 1000, noNaN: true, noDefaultInfinity: true }),
        async (n, entryPrice, exitPrice) => {
          await db.delete(fills); await db.delete(trades); await db.delete(portfolio);
          const buy = await attemptOrder('BUY', n, 0, entryPrice);
          expect(buy.accepted).toBe(true);
          const firstSell = await attemptOrder('SELL', n, n, exitPrice);
          expect(firstSell.accepted).toBe(true);
          expect(currentPortfolioQuantity()).toBe(0);
          // Stale snapshot: remote still reports the pre-close quantity.
          const secondSell = await attemptOrder('SELL', n, n, exitPrice);
          expect(secondSell.accepted).toBe(false);
          expect(currentPortfolioQuantity()).toBe(0);
        },
      ),
      { numRuns: 200, seed: fcSeed },
    );
  });
});
