import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * ReflectionEngine must learn from closed, realized P&L (FILLED SELL with profitLoss), never
 * from mark-to-market on an open BUY that is temporarily underwater.
 */
describe('ReflectionEngine - closed-trade-only loss reflection', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let reflectionEngine: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_reflection_closed_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ reflectionEngine } = await import('./ReflectionEngine'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('does not generate a learned rule from an open underwater BUY', async () => {
    await db.insert(schema.trades).values({
      id: 'open-buy-1',
      symbol: 'AAPL',
      side: 'BUY',
      quantity: 10,
      price: 200,
      status: 'FILLED',
      timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      filledAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      profitLoss: null,
      reasoning: 'still open',
    } as any);

    const spy = vi.spyOn(reflectionEngine, 'generateReflectionRule').mockResolvedValue(undefined);
    await reflectionEngine.evaluateAgents();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does generate a learned rule from a recently closed SELL with negative realized P&L', async () => {
    await db.insert(schema.trades).values({
      id: 'closed-sell-1',
      symbol: 'MSFT',
      side: 'SELL',
      quantity: 5,
      price: 90,
      status: 'FILLED',
      timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      filledAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      profitLoss: -50,
      reasoning: 'stopped out',
    } as any);

    const spy = vi.spyOn(reflectionEngine, 'generateReflectionRule').mockResolvedValue(undefined);
    await reflectionEngine.evaluateAgents();
    expect(spy).toHaveBeenCalled();
    const losses = spy.mock.calls[0][0];
    expect(losses.some((l: any) => l.symbol === 'MSFT' && l.realizedPnl === -50)).toBe(true);
    expect(losses.some((l: any) => l.symbol === 'AAPL')).toBe(false);
    spy.mockRestore();
  });
});
