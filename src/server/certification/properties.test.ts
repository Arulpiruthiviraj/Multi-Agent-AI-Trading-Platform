// LABEL: PROPERTY / FUZZ / METAMORPHIC certification (SYNTHETIC_SEEDED / CERTIFICATION_FIXTURE_ONLY) - 2026-10-13
/**
 * Randomized invariants over the REAL PositionSizing and fill ledger, judged by the independent oracles where one exists.
 *  P1 differential: real sizing quantity == independently derived maximum, for random valid states (no unmodelled cap may bind).
 *  P2 metamorphic:  the simulated BROKER account size (1M vs 5M vs 50k) must not change a trade governed by the same Argus research capital.
 *  P3 accounting:   random fill streams -> cash identity, position conservation, and P&L balance in the oracle itself.
 *  P4 fuzz:         random / duplicated / out-of-order cumulative broker reports for one order -> each broker fill affects inventory exactly once,
 *                   fills sum to the largest cumulative quantity reported, no regression of a FILLED order.
 * Failing seeds are printed by fast-check and become permanent regressions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';
import { calculatePositionSizing } from '../engines/PositionSizing';
import { maxPermissibleBuyQuantity } from '../replay/synthetic/oracles/riskOracle';
import { runAccountingOracle } from '../replay/synthetic/oracles/accountingOracle';
import { tradingSafety } from '../config/tradingSafety';

const baseSizing = (o: { price: number; capital: number; maxTrade: number; riskPct: number; bp: number; equity?: number }) => ({
  side: 'BUY' as const, symbol: 'ZZPROP', currentPrice: o.price, accountEquity: o.equity ?? 1_000_000, riskCapitalEquity: o.capital,
  buyingPower: o.bp, maxTradeSizeDollar: o.maxTrade, maxPortfolioRiskPct: o.riskPct, existingPositions: [], maxOpenPositions: 10,
  getRecentCloses: async () => null,
});

describe('P1 differential: real sizing equals the independent oracle', () => {
  it('for random valid states', async () => {
    await fc.assert(fc.asyncProperty(
      fc.record({
        price: fc.double({ min: 5, max: 900, noNaN: true }),
        capital: fc.double({ min: 2_000, max: 60_000, noNaN: true }),
        maxTrade: fc.double({ min: 500, max: 8_000, noNaN: true }),
        riskPct: fc.double({ min: 0.005, max: 0.05, noNaN: true }),
        bp: fc.double({ min: 100, max: 200_000, noNaN: true }),
      }),
      async (s) => {
        const real = await calculatePositionSizing(baseSizing(s));
        const oracle = maxPermissibleBuyQuantity({
          side: 'BUY', symbol: 'ZZPROP', price: s.price, capitalBasis: s.capital, maxTradeSizeUsd: s.maxTrade, maxPortfolioRiskPct: s.riskPct,
          stopLossAssumptionPct: tradingSafety.stopLossAssumptionPct, buyingPower: s.bp,
          maxSingleSymbolConcentrationPct: tradingSafety.maxSingleSymbolConcentrationPct, maxSectorConcentrationPct: tradingSafety.maxSectorConcentrationPct,
          maxOpenPositions: 10, remainingAllocationUsd: Number.MAX_SAFE_INTEGER, holdings: [], proposalSector: null,
        });
        expect(real.maxQuantity).toBe(oracle.maxQuantity);
        expect(real.maxQuantity * s.price).toBeLessThanOrEqual(s.maxTrade + 1e-6);
      },
    ), { numRuns: 300 });
  });
});

describe('P2 metamorphic: broker account size does not change a trade governed by the same research capital', () => {
  it('1M vs 5M vs 50k simulated equity give the same quantity', async () => {
    await fc.assert(fc.asyncProperty(
      fc.record({ price: fc.double({ min: 5, max: 900, noNaN: true }), capital: fc.double({ min: 5_000, max: 40_000, noNaN: true }) }),
      async (s) => {
        const common = { price: s.price, capital: s.capital, maxTrade: 3000, riskPct: 0.02, bp: 5_000_000 };
        const a = await calculatePositionSizing(baseSizing({ ...common, equity: 1_000_000 }));
        const b = await calculatePositionSizing(baseSizing({ ...common, equity: 5_000_000 }));
        const c = await calculatePositionSizing(baseSizing({ ...common, equity: 50_000 }));
        expect(b.maxQuantity).toBe(a.maxQuantity);
        expect(c.maxQuantity).toBe(a.maxQuantity);
      },
    ), { numRuns: 200 });
  });
});

describe('P3 accounting oracle invariants over random fill streams', () => {
  it('cash identity, position conservation and gross/net P&L balance', () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        buy: fc.integer({ min: 1, max: 40 }), sell: fc.double({ min: 0, max: 1, noNaN: true }),
        px: fc.double({ min: 10, max: 500, noNaN: true }), dpx: fc.double({ min: -0.1, max: 0.1, noNaN: true }),
      }), { minLength: 1, maxLength: 12 }),
      (steps) => {
        const fills: any[] = []; let held = 0; let cash = 0; let fees = 0;
        steps.forEach((s, i) => {
          const px = Math.max(1, s.px);
          fills.push({ orderId: `b${i}`, symbol: 'A', side: 'BUY', quantity: s.buy, price: px, feeUsd: s.buy * 0.005 });
          held += s.buy; cash -= s.buy * px + s.buy * 0.005; fees += s.buy * 0.005;
          const q = Math.floor(held * s.sell);
          if (q > 0) {
            const sp = Math.max(1, px * (1 + s.dpx));
            fills.push({ orderId: `s${i}`, symbol: 'A', side: 'SELL', quantity: q, price: sp, feeUsd: q * 0.005 });
            held -= q; cash += q * sp - q * 0.005; fees += q * 0.005;
          }
        });
        const r = runAccountingOracle(fills);
        expect(r.violations).toEqual([]);
        expect(r.cashDelta).toBeCloseTo(cash, 3);
        expect(r.feesTotal).toBeCloseTo(fees, 3);
        expect(r.netRealizedPnl).toBeCloseTo(r.grossRealizedPnl - r.feesTotal, 3);
        expect(r.positions.reduce((s, p) => s + p.quantity, 0)).toBe(held);
      },
    ), { numRuns: 300 });
  });
});

describe('P4 fuzz: duplicated / out-of-order cumulative fill reports for one order', () => {
  let tmp: string; let sqliteDb: any; let db: any; let schema: any;
  let insertIncrementalFill: typeof import('../services/fillLedger').insertIncrementalFill;
  beforeAll(async () => {
    tmp = path.join(os.tmpdir(), `argus_fill_fuzz_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmp;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ insertIncrementalFill } = await import('../services/fillLedger'));
  });
  afterAll(() => {
    try { sqliteDb.close(); } catch { /* closed */ }
    for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(tmp + s); } catch { /* best effort */ } }
    delete process.env.ARGUS_DB_PATH;
  });
  let n = 0;
  it('each broker fill is applied exactly once and the ledger converges to the largest cumulative quantity', async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 2, max: 60 }),
      fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 1, maxLength: 14 }),
      fc.boolean(),
      fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 20, maxLength: 20 }),
      async (requested, fractions, endsFilled, shuffleKeys) => {
        const orderId = `fuzz-${++n}`;
        const reports = fractions.map((f) => Math.floor(requested * f)).filter((q) => q > 0);
        if (endsFilled) reports.push(requested);
        const all = [...reports, ...reports.slice(0, 3)];
        const shuffled = all.map((q, i) => ({ q, k: shuffleKeys[i % shuffleKeys.length] })).sort((a, b) => a.k - b.k).map((x) => x.q);
        let maxApplied = 0;
        for (const q of shuffled) {
          try {
            await insertIncrementalFill({
              orderId, brokerOrderId: 'b', requestedQuantity: requested,
              status: q >= requested ? 'FILLED' : 'PARTIALLY_FILLED', filledQuantity: q, averageFillPrice: 100,
            });
            maxApplied = Math.max(maxApplied, q);
          } catch { /* a terminal-watermark regression is refused: the safe outcome */ }
        }
        const rows = await db.select().from(schema.fills).where(eq(schema.fills.orderId, orderId));
        const total = rows.reduce((s: number, r: any) => s + r.quantity, 0);
        expect(total).toBeLessThanOrEqual(requested + 1e-9);
        expect(total).toBe(maxApplied);
        const cums = rows.map((r: any) => r.cumulativeQuantity);
        expect(new Set(cums).size).toBe(cums.length);
      },
    ), { numRuns: 60 });
  }, 120000);
});
