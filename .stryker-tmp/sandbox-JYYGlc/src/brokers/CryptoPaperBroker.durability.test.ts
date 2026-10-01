// @ts-nocheck
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

/**
 * Crypto Gap Analysis G5 (ARGUS_CRYPTO_TRADING_REDESIGN_PLAN.md) durable restart recovery
 * (2026-09-28). CryptoPaperBroker.ts previously held cash/positions/orders purely in an
 * in-memory Map; a process restart silently lost the entire simulated portfolio. These tests use
 * an isolated temp SQLite DB (own ARGUS_DB_PATH, never data/argus.db - see vitest.setup.ts's
 * default isolation, overridden here the same way OrderManagement.crashRecovery.test.ts does) and
 * construct a SECOND, independent CryptoPaperBroker instance against the SAME db file to simulate
 * a real restart (a fresh in-memory Map, hydrated only from durable state) without needing a
 * second process.
 */
describe('CryptoPaperBroker - G5 durable restart recovery', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let CryptoPaperBroker: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_crypto_paper_durability_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../server/db'));
    schema = await import('../server/db/schema');
    ({ CryptoPaperBroker } = await import('./CryptoPaperBroker'));
  });

  beforeEach(() => {
    // Each test constructs its own fresh CryptoPaperBroker instance(s), so the durable tables
    // themselves must also start empty each time - otherwise a later test's initialize() would
    // hydrate a real, still-open position/order left behind by an earlier test in this same file
    // (they all share one isolated DB file, not a fresh one per test).
    db.delete(schema.cryptoPaperOrders).run();
    db.delete(schema.cryptoPaperPositions).run();
    db.delete(schema.cryptoPaperBrokerState).run();
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('a fresh broker with no prior state persists its own starting snapshot on first initialize()', async () => {
    const broker = new CryptoPaperBroker(55000);
    await broker.initialize();
    const row = db.select().from(schema.cryptoPaperBrokerState).where(eq(schema.cryptoPaperBrokerState.id, 'singleton')).get();
    expect(row).toBeTruthy();
    expect(row.cash).toBe(55000);
    expect(row.initialCash).toBe(55000);
  });

  it('cash, an open position and a filled order all survive a simulated restart (fresh instance, same db)', async () => {
    const broker1 = new CryptoPaperBroker(100000);
    await broker1.initialize();
    await broker1.placeOrder({ symbol: 'BTC-USD', side: 'BUY', quantity: 0.5, clientOrderId: 'restart-buy-1' });
    broker1.tick({ 'BTC-USD': 40000 });
    const filled = (await broker1.orders())[0];
    expect(filled.status).toBe('FILLED');
    const portfolioBefore = await broker1.portfolio();
    expect(portfolioBefore.positions).toHaveLength(1);

    // Simulate a restart: a brand-new instance, no shared in-memory state, same underlying DB file.
    const broker2 = new CryptoPaperBroker(999999); // deliberately wrong default - must be overridden by real persisted state
    await broker2.initialize();

    const portfolioAfter = await broker2.portfolio();
    expect(portfolioAfter.cash).toBeCloseTo(portfolioBefore.cash, 8);
    expect(portfolioAfter.positions).toHaveLength(1);
    expect(portfolioAfter.positions[0].symbol).toBe('BTC-USD');
    expect(portfolioAfter.positions[0].quantity).toBeCloseTo(0.5, 8);
    expect(portfolioAfter.positions[0].entryPrice).toBeCloseTo(portfolioBefore.positions[0].entryPrice, 8);

    const restoredOrders = await broker2.orders();
    expect(restoredOrders).toHaveLength(1);
    expect(restoredOrders[0].status).toBe('FILLED');
    expect(restoredOrders[0].id).toBe(filled.id);

    // Duplicate-event protection survives the restart too: replaying the SAME clientOrderId
    // against the new instance must return the persisted original order, never place a second one.
    const replay = await broker2.placeOrder({ symbol: 'BTC-USD', side: 'BUY', quantity: 0.5, clientOrderId: 'restart-buy-1' });
    expect(replay.id).toBe(filled.id);
    expect((await broker2.orders())).toHaveLength(1);
  });

  it('a fully-closed position (deleted from the in-memory Map) is also removed from durable storage, not left as a stale zero-quantity row', async () => {
    const broker = new CryptoPaperBroker(100000);
    await broker.initialize();
    await broker.placeOrder({ symbol: 'ETH-USD', side: 'BUY', quantity: 2, clientOrderId: 'close-buy-1' });
    broker.tick({ 'ETH-USD': 2000 });
    await broker.placeOrder({ symbol: 'ETH-USD', side: 'SELL', quantity: 2, clientOrderId: 'close-sell-1' });
    broker.tick({ 'ETH-USD': 2000 });
    expect((await broker.positions())).toHaveLength(0);

    const row = db.select().from(schema.cryptoPaperPositions).where(eq(schema.cryptoPaperPositions.symbol, 'ETH-USD')).get();
    expect(row, 'a fully closed position must not remain as a stale row in durable storage').toBeUndefined();

    // Restart recovery must therefore correctly show zero positions too, not resurrect a stale one.
    const broker2 = new CryptoPaperBroker(100000);
    await broker2.initialize();
    expect((await broker2.positions())).toHaveLength(0);
  });

  it('a cancelled order persists its CANCELED status and survives a restart', async () => {
    const broker = new CryptoPaperBroker(100000);
    await broker.initialize();
    const order = await broker.placeOrder({ symbol: 'BTC-USD', side: 'BUY', quantity: 0.1, clientOrderId: 'cancel-me-1' });
    const cancelled = await broker.cancelOrder(order.id);
    expect(cancelled).toBe(true);

    const broker2 = new CryptoPaperBroker(100000);
    await broker2.initialize();
    const restored = (await broker2.orders()).find((o: any) => o.id === order.id);
    expect(restored?.status).toBe('CANCELED');
  });

  it('cash and position rows in durable storage exactly match in-memory state after a partial fill (write-through consistency, not just eventual)', async () => {
    const broker = new CryptoPaperBroker(100000);
    await broker.initialize();
    await broker.placeOrder({ symbol: 'BTC-USD', side: 'BUY', quantity: 10, clientOrderId: 'partial-buy-1' });
    broker.tick({ 'BTC-USD': 40000 }); // bounded by maxFillNotionalPerTick - a real partial fill

    const memPortfolio = await broker.portfolio();
    const stateRow = db.select().from(schema.cryptoPaperBrokerState).where(eq(schema.cryptoPaperBrokerState.id, 'singleton')).get();
    expect(stateRow.cash).toBeCloseTo(memPortfolio.cash, 8);

    if (memPortfolio.positions.length > 0) {
      const posRow = db.select().from(schema.cryptoPaperPositions).where(eq(schema.cryptoPaperPositions.symbol, 'BTC-USD')).get();
      expect(posRow.quantity).toBeCloseTo(memPortfolio.positions[0].quantity, 8);
      expect(posRow.entryPrice).toBeCloseTo(memPortfolio.positions[0].entryPrice, 8);
    }
  });
});
