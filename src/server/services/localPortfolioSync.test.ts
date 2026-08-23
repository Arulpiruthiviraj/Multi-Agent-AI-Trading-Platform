import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

describe('syncLocalPortfolioAfterFullSellFill', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let syncLocalPortfolioAfterFullSellFill: typeof import('./localPortfolioSync').syncLocalPortfolioAfterFullSellFill;
  let isOrderFullyFilled: typeof import('./localPortfolioSync').isOrderFullyFilled;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_local_pf_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ syncLocalPortfolioAfterFullSellFill, isOrderFullyFilled } = await import('./localPortfolioSync'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  beforeEach(async () => {
    await db.delete(schema.portfolio);
  });

  it('deletes local portfolio row after a full SELL fill covering the holding', async () => {
    await db.insert(schema.portfolio).values({
      symbol: 'NVDA',
      quantity: 1,
      averagePrice: 206.85,
      currentPrice: 216.89,
      lastUpdated: new Date().toISOString(),
      brokerSource: 'test',
    });

    expect(isOrderFullyFilled('FILLED', 1, 1)).toBe(true);
    const result = await syncLocalPortfolioAfterFullSellFill('NVDA', 1);
    expect(result.updated).toBe(true);
    expect(result.remainingQty).toBe(0);

    const rows = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, 'NVDA'));
    expect(rows).toHaveLength(0);
  });

  it('reduces local qty when SELL fills less than the full holding', async () => {
    await db.insert(schema.portfolio).values({
      symbol: 'AAPL',
      quantity: 10,
      averagePrice: 100,
      lastUpdated: new Date().toISOString(),
    });

    const result = await syncLocalPortfolioAfterFullSellFill('AAPL', 3);
    expect(result.updated).toBe(true);
    expect(result.remainingQty).toBe(7);

    const rows = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, 'AAPL'));
    expect(rows[0]?.quantity).toBe(7);
  });

  it('is a no-op when no local portfolio row exists (does not invent a position)', async () => {
    const result = await syncLocalPortfolioAfterFullSellFill('GHOST', 1);
    expect(result.updated).toBe(false);
    const rows = await db.select().from(schema.portfolio);
    expect(rows).toHaveLength(0);
  });
});
