import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import { trades, portfolio } from '../db/schema';
import { prepareOrderPosition } from './positionFillEvidence';
import { tradingSafety } from '../config/tradingSafety';

// Real defect (2026-10-08 defect hunt, D2): prepareOrderPosition's sibling
// POSITION_ORDER_UNRESOLVED check had no age bound. After an InternalPaperBroker
// restart (in-memory orders lost), a PENDING row could never resolve, and this
// check then refused every future order for the symbol forever - a permanent,
// silent per-symbol trading halt. The check is now bounded to the same
// crash-recovery lookback the recovery paths use. Real isolated test DB.
describe('prepareOrderPosition sibling age bound (D2)', () => {
  beforeAll(() => { expect(process.env.ARGUS_DB_PATH).toContain('argus_test_'); });
  beforeEach(async () => {
    await db.delete(trades);
    await db.delete(portfolio);
    await db.insert(portfolio).values({
      symbol: 'AAA', quantity: 10, averagePrice: 100, brokerSource: 'internal_paper',
      lastUpdated: new Date().toISOString(),
    } as any);
  });

  const mainOrder = (id: string) => ({
    id, symbol: 'AAA', side: 'BUY', quantity: 5, price: 100, status: 'PENDING',
    timestamp: new Date().toISOString(), brokerId: 'internal_paper',
    executionEnvironment: 'PAPER', submittedAt: new Date().toISOString(),
  }) as any;

  const stuckSibling = (id: string, submittedAtIso: string | null) => ({
    id, symbol: 'AAA', side: 'BUY', quantity: 5, price: 100, status: 'PENDING',
    timestamp: new Date().toISOString(), brokerId: 'internal_paper',
    executionEnvironment: 'PAPER', submittedAt: submittedAtIso,
  }) as any;

  it('does NOT block on a PENDING sibling older than the crash-recovery lookback', async () => {
    const old = new Date(Date.now() - tradingSafety.crashRecoveryLookbackMs - 60_000).toISOString();
    await db.insert(trades).values([mainOrder('main-1'), stuckSibling('stuck-old', old)]);
    // Remote broker quantity matches the local 10-share baseline, so the only
    // possible blocker is the sibling check.
    expect(prepareOrderPosition('main-1', { quantity: 10, entryPrice: 100 })).toBeNull();
  });

  it('STILL blocks on a PENDING sibling inside the recovery window', async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    await db.insert(trades).values([mainOrder('main-2'), stuckSibling('stuck-recent', recent)]);
    expect(prepareOrderPosition('main-2', { quantity: 10, entryPrice: 100 })).toBe('POSITION_ORDER_UNRESOLVED');
  });

  it('STILL blocks on a PENDING sibling with unknown (NULL) submitted_at - fail closed', async () => {
    await db.insert(trades).values([mainOrder('main-3'), stuckSibling('stuck-null', null)]);
    expect(prepareOrderPosition('main-3', { quantity: 10, entryPrice: 100 })).toBe('POSITION_ORDER_UNRESOLVED');
  });
});
