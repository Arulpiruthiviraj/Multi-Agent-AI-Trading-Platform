import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fills } from '../db/schema';
import { eq } from 'drizzle-orm';

describe('fillLedger idempotency', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let db: any;
  let insertIncrementalFill: typeof import('./fillLedger').insertIncrementalFill;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_fills_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    ({ insertIncrementalFill } = await import('./fillLedger'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('duplicate cumulative fill of the same order is a unique no-op', async () => {
    const orderId = `fill-dup-${Date.now()}`;
    const payload = {
      orderId,
      brokerOrderId: 'brk-1',
      requestedQuantity: 10,
      status: 'FILLED' as const,
      filledQuantity: 10,
      averageFillPrice: 100,
    };
    const [a, b] = await Promise.all([
      insertIncrementalFill(payload),
      insertIncrementalFill(payload),
    ]);
    expect(a.newQty + b.newQty).toBe(10);
    const rows = await db.select().from(fills).where(eq(fills.orderId, orderId));
    const totalQty = rows.reduce((s: number, r: { quantity: number }) => s + r.quantity, 0);
    expect(totalQty).toBe(10);
    expect(rows).toHaveLength(1);
  });

  it('partial then remaining fill records two rows summing to requested qty', async () => {
    const orderId = `fill-partial-${Date.now()}`;
    const p1 = await insertIncrementalFill({
      orderId,
      brokerOrderId: 'brk-2',
      requestedQuantity: 10,
      status: 'PARTIALLY_FILLED',
      filledQuantity: 4,
      averageFillPrice: 10,
    });
    const p2 = await insertIncrementalFill({
      orderId,
      brokerOrderId: 'brk-2',
      requestedQuantity: 10,
      status: 'FILLED',
      filledQuantity: 10,
      averageFillPrice: 11,
    });
    expect(p1.newQty).toBe(4);
    expect(p2.newQty).toBe(6);
    const rows = await db.select().from(fills).where(eq(fills.orderId, orderId));
    expect(rows).toHaveLength(2);
    expect(rows.reduce((s: number, r: { quantity: number }) => s + r.quantity, 0)).toBe(10);
    expect(rows.reduce((s: number, r: any) => s + r.quantity * r.price, 0)).toBeCloseTo(110);
    expect(p2.incrementalPrice).toBeCloseTo(70 / 6);
  });

  it('serializes distinct concurrent watermarks and ignores an older report', async () => {
    const orderId = 'fill-concurrent-watermarks';
    const base = { orderId, brokerOrderId: 'b', requestedQuantity: 3, status: 'PARTIALLY_FILLED', averageFillPrice: 11 };
    await Promise.all([1, 2, 3, 2].map(filledQuantity => insertIncrementalFill({ ...base, filledQuantity })));
    const rows = await db.select().from(fills).where(eq(fills.orderId, orderId));
    expect(rows.reduce((s: number, r: any) => s + r.quantity, 0)).toBe(3);
    expect(rows.reduce((s: number, r: any) => s + r.quantity * r.price, 0)).toBeCloseTo(33);
  });

  it.each([
    { filledQuantity: undefined }, { filledQuantity: Infinity }, { filledQuantity: -1 },
    { filledQuantity: 4 }, { averageFillPrice: undefined }, { averageFillPrice: 0 },
    { averageFillPrice: NaN }, { averageFillPrice: Infinity },
  ])('refuses incomplete or invalid economics %j', async (invalid) => {
    const orderId = 'invalid-fill';
    await expect(insertIncrementalFill({ orderId, brokerOrderId: 'b', requestedQuantity: 3,
      status: 'FILLED', filledQuantity: 3, averageFillPrice: 10, ...invalid })).rejects.toThrow();
    expect(await db.select().from(fills).where(eq(fills.orderId, orderId))).toHaveLength(0);
  });
});
