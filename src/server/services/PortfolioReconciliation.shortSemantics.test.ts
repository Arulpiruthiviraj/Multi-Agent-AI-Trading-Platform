import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, sqliteDb } from '../db';
import { trades, fills, portfolio, reconciliationEvents } from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import { BrokerManager } from '../../brokers/BrokerManager';
import { HistoricalReplayBroker } from '../../brokers/HistoricalReplayBroker';
import { replaySafety } from '../replay/replaySafety';
import { OrderManagementService } from './OrderManagement';
import { portfolioReconciliationWorker } from './PortfolioReconciliation';
import { insertIncrementalFill } from './fillLedger';

/**
 * ARGUS_SHORT_RECONCILIATION_SEMANTICS_FIX (2026-10-06), OKTA forensic audit follow-up.
 *
 * The forensic audit (docs/audits/ARGUS_OKTA_RECONCILIATION_FORENSIC_2026-10-06.md) found that
 * PortfolioReconciliation.ts's short-position branch always recorded a hardcoded `localQty: 0`
 * sentinel and the type SHORT_POSITION_UNMONITORED - even when the authoritative fill ledger
 * (`fills.position_quantity_after`) already knew the TRUE signed quantity and AGREED with the
 * broker. That is not a real disagreement; it is a cache (the `portfolio` table) that refuses to
 * represent a short at all. This suite proves the fix classifies all six scenarios correctly:
 *
 *   A. broker=+14, ledger=+14, portfolio=+14           -> MATCH
 *   B. broker=0,   ledger=0,   portfolio absent         -> MATCH (true flat, not confused with C)
 *   C. broker=-14, ledger=-14, portfolio cannot represent -> UNMANAGED_SHORT_POSITION (new, core case)
 *   D. broker=-14, ledger=0                             -> REAL mismatch (POSITION_FILL_CONFLICT), never softened
 *   E. broker=0,   ledger=-14                           -> REAL mismatch (POSITION_FILL_CONFLICT), never swallowed
 *   F. broker unreadable                                -> SYNC_FAILURE, unchanged, fail-closed
 *
 * NON_ORGANIC / CERTIFICATION_FIXTURE_ONLY. Real isolated DB, real OMS, real fill ledger, real
 * PortfolioReconciliationWorker.reconcile() - only the broker's own portfolio() response is
 * deliberately shaped per scenario to reproduce each authoritative-source combination without
 * waiting on a real broker disagreement.
 */
describe('PortfolioReconciliation short-position semantics (OKTA forensic fix)', () => {
  let broker: HistoricalReplayBroker;
  let oms: OrderManagementService;

  beforeEach(async () => {
    await db.delete(fills);
    await db.delete(trades);
    await db.delete(portfolio);
    broker = new HistoricalReplayBroker({
      initialCash: 100000, costs: replaySafety.costProfiles.Base,
      timezone: 'America/New_York', extendedHours: false, shortSelling: true, fractional: false,
    });
    broker.clockNowMs = Date.UTC(2026, 9, 1, 18, 30);
    BrokerManager.getInstance().registerBroker(broker);
    await BrokerManager.getInstance().setActiveBroker(broker.id, {});
    BrokerManager.getInstance().resetSyncStateForTests('READY');
    portfolioReconciliationWorker.resetFaultDebounceForTests();
    oms = new OrderManagementService();
  });

  const order = (trace: string) => sqliteDb.prepare('SELECT * FROM trades WHERE trace_id=?').get(trace) as any;
  const latestMismatches = async (): Promise<Array<{ symbol: string; type: string; localQty: number; remoteQty: number }>> => {
    const [row] = await db.select().from(reconciliationEvents).orderBy(desc(reconciliationEvents.id)).limit(1);
    return row?.mismatches ? JSON.parse(row.mismatches) : [];
  };

  async function buyThenClose(): Promise<void> {
    broker.nextFillPrice.set('OKTA', 211.72);
    await oms.executeOrder('OKTA', 'BUY', 14, 'CERTIFICATION_FIXTURE_ONLY', 'entry');
    expect(order('entry').status).toBe('FILLED');
    broker.nextFillPrice.set('OKTA', 212.49);
    await oms.executeOrder('OKTA', 'SELL', 14, 'CERTIFICATION_FIXTURE_ONLY', 'exit');
    expect(order('exit').status).toBe('FILLED');
  }

  /** Directly reconstructs a real opening-short fill ledger entry for OKTA, exactly as the
   * now-fixed 2026-10-01 defect would have produced it, bypassing the already-patched gate 22
   * on purpose (this suite is testing RECONCILIATION classification, not re-litigating the
   * already-fixed order-placement defect, which has its own dedicated regression test in
   * OrderManagement.positionEvidence.test.ts). */
  async function openUnexpectedShort(): Promise<void> {
    await db.insert(trades).values({
      id: 'unexpected-short', symbol: 'OKTA', side: 'SELL', quantity: 14, price: 212.61,
      status: 'RECONCILIATION_REQUIRED', timestamp: new Date().toISOString(), brokerId: broker.id,
      executionEnvironment: 'REPLAY', positionQuantityBefore: 0, positionAveragePriceBefore: 0,
    });
    await insertIncrementalFill({
      orderId: 'unexpected-short', brokerOrderId: null, requestedQuantity: 14, status: 'FILLED',
      filledQuantity: 14, averageFillPrice: 212.61, applyPosition: true,
    });
    expect(sqliteDb.prepare('SELECT position_quantity_after FROM fills WHERE order_id=?').get('unexpected-short'))
      .toEqual({ position_quantity_after: -14 });
  }

  it('A: broker=+14, ledger=+14, portfolio=+14 -> MATCH', async () => {
    await buyThenClose(); // leaves OKTA flat
    broker.nextFillPrice.set('OKTA', 215);
    await oms.executeOrder('OKTA', 'BUY', 14, 'CERTIFICATION_FIXTURE_ONLY', 'reentry');
    expect(order('reentry').status).toBe('FILLED');
    expect(sqliteDb.prepare('SELECT quantity FROM portfolio WHERE symbol=?').get('OKTA')).toEqual({ quantity: 14 });

    await portfolioReconciliationWorker.reconcile();

    const mismatches = await latestMismatches();
    expect(mismatches.filter((m) => m.symbol === 'OKTA')).toEqual([]);
    const [latest] = await db.select().from(reconciliationEvents).orderBy(desc(reconciliationEvents.id)).limit(1);
    expect(latest.matches).toBe(true);
  });

  it('B: broker=0, ledger=0, portfolio absent -> MATCH (true flat, not confused with C)', async () => {
    await buyThenClose(); // OKTA fully flat: broker 0, ledger 0, no portfolio row
    expect(sqliteDb.prepare('SELECT * FROM portfolio WHERE symbol=?').get('OKTA')).toBeUndefined();

    await portfolioReconciliationWorker.reconcile();

    const mismatches = await latestMismatches();
    expect(mismatches.filter((m) => m.symbol === 'OKTA')).toEqual([]);
  });

  it('C: broker=-14, ledger=-14, portfolio cannot represent it -> UNMANAGED_SHORT_POSITION (core fix)', async () => {
    await openUnexpectedShort();
    // Simulate the forensic audit's "Divergence B": the portfolio cache row is lost/absent even
    // though the fill ledger and broker both still agree on -14.
    await db.delete(portfolio).where(eq(portfolio.symbol, 'OKTA'));
    expect(sqliteDb.prepare('SELECT * FROM portfolio WHERE symbol=?').get('OKTA')).toBeUndefined();

    const realPortfolio = broker.portfolio.bind(broker);
    vi.spyOn(broker, 'portfolio').mockImplementation(async () => {
      const real = await realPortfolio();
      return { ...real, positions: [...real.positions, {
        symbol: 'OKTA', quantity: -14, entryPrice: 212.61, currentPrice: 212.61,
        marketValue: -2976.54, unrealizedPnl: 0, unrealizedPnlPercent: 0, valuationStatus: 'VALUED',
      }] };
    });

    await portfolioReconciliationWorker.reconcile();

    const mismatches = await latestMismatches();
    const okta = mismatches.filter((m) => m.symbol === 'OKTA');
    expect(okta).toEqual([
      expect.objectContaining({ type: 'UNMANAGED_SHORT_POSITION', localQty: -14, remoteQty: -14 }),
    ]);
    // Never a fabricated "both sides disagree" framing when they actually agree.
    expect(okta.some((m) => m.type === 'SHORT_POSITION_UNMONITORED')).toBe(false);
    expect(okta.some((m) => m.type.startsWith('POSITION_FILL_'))).toBe(false);
    // Still never hydrated into the long-only portfolio cache.
    expect(sqliteDb.prepare('SELECT * FROM portfolio WHERE symbol=?').get('OKTA')).toBeUndefined();
  });

  it('D: broker=-14, ledger=0 -> REAL mismatch (POSITION_FILL_CONFLICT), never softened to UNMANAGED_SHORT_POSITION', async () => {
    await buyThenClose(); // ledger genuinely flat (0) for OKTA
    expect(sqliteDb.prepare('SELECT * FROM portfolio WHERE symbol=?').get('OKTA')).toBeUndefined();

    const realPortfolio = broker.portfolio.bind(broker);
    vi.spyOn(broker, 'portfolio').mockImplementation(async () => {
      const real = await realPortfolio();
      return { ...real, positions: [...real.positions, {
        symbol: 'OKTA', quantity: -14, entryPrice: 212.61, currentPrice: 212.61,
        marketValue: -2976.54, unrealizedPnl: 0, unrealizedPnlPercent: 0, valuationStatus: 'VALUED',
      }] };
    });

    await portfolioReconciliationWorker.reconcile();

    const mismatches = await latestMismatches();
    const okta = mismatches.filter((m) => m.symbol === 'OKTA');
    expect(okta).toEqual([
      expect.objectContaining({ type: 'POSITION_FILL_CONFLICT', remoteQty: -14 }),
    ]);
    expect(okta.some((m) => m.type === 'UNMANAGED_SHORT_POSITION')).toBe(false);
  });

  it('E: broker=0 (absent), ledger=-14 -> REAL mismatch, never silently swallowed', async () => {
    await openUnexpectedShort();
    // Broker now reports OKTA as flat/absent (e.g. closed outside Argus) while the fill ledger
    // still shows the real -14. The portfolio cache also has no row for OKTA (shorts are never
    // hydrated there), so neither of the two position-compare loops would visit this symbol at
    // all without the dedicated fill-ledger-only cross-check added by this fix.
    await db.delete(portfolio).where(eq(portfolio.symbol, 'OKTA'));
    expect(sqliteDb.prepare('SELECT * FROM portfolio WHERE symbol=?').get('OKTA')).toBeUndefined();
    // broker.portfolio() reports OKTA absent (real HistoricalReplayBroker state is already flat
    // here, since the short was injected directly into the ledger/portfolio table bypassing the
    // broker simulator entirely) - no mock needed, broker genuinely has no OKTA position.

    await portfolioReconciliationWorker.reconcile();

    const mismatches = await latestMismatches();
    const okta = mismatches.filter((m) => m.symbol === 'OKTA');
    expect(okta).toEqual([
      expect.objectContaining({ type: 'POSITION_FILL_CONFLICT', remoteQty: 0 }),
    ]);
  });

  it('F: broker unreadable -> SYNC_FAILURE, unchanged, fail-closed', async () => {
    vi.spyOn(broker, 'portfolio').mockRejectedValue(new Error('simulated broker outage'));

    await portfolioReconciliationWorker.reconcile();

    const [latest] = await db.select().from(reconciliationEvents).orderBy(desc(reconciliationEvents.id)).limit(1);
    expect(latest.matches).toBe(false);
    expect(latest.mismatches).toContain('SYNC_FAILURE');
  });
});
