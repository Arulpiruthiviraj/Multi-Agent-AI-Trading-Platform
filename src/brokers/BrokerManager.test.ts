import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';
import type { BrokerCapabilities, BrokerPlugin } from './BrokerAdapter';

/**
 * Real integration test (isolated temp SQLite DB) for setLiveMode()'s capability gate - added
 * after a live "Add/Update Credentials" panel review found this had none: a broker with
 * placeOrder() implemented but missing ONE of paperTrading/liveTrading specifically (Coinbase has
 * no sandbox; the Internal Paper Simulator has no real account to go live) could previously be set
 * to the unsupported mode with no error, only failing later at actual order-placement time.
 */
describe('BrokerManager.setLiveMode capability gate', () => {
  let tmpDbPath: string;
  let BrokerManager: any;
  let db: any;
  let sqliteDb: any;
  let schema: any;

  function fakeBroker(id: string, caps: Partial<BrokerCapabilities>): BrokerPlugin {
    return {
      id,
      name: `Fake ${id}`,
      initialize: async () => {},
      authenticate: async () => true,
      validateCredentials: async () => true,
      paperTrading: () => {},
      liveTrading: () => {},
      getCapabilities: () => ({
        canPlaceOrders: true, canCancelOrders: true, paperTrading: false, liveTrading: false,
        usEquities: true, canadianEquities: false, crypto: false, options: false,
        shortSelling: false, streamingMarketData: false, requiresManualReauth: false,
        ...caps,
      }),
      portfolio: async () => ({ cash: 0, buyingPower: 0, equity: 0, positions: [] }),
      orders: async () => [],
      positions: async () => [],
      account: async () => ({}),
      disconnect: async () => {},
      health: async () => 'Healthy',
      placeOrder: async () => { throw new Error('not used in this test'); },
      cancelOrder: async () => false,
      closePosition: async () => false,
    };
  }

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_brokermgr_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../server/db'));
    schema = await import('../server/db/schema');
    ({ BrokerManager } = await import('./BrokerManager'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('refuses to switch to LIVE for a broker whose capabilities say liveTrading:false, even with the confirmation phrase', async () => {
    const manager = BrokerManager.getInstance();
    manager.registerBroker(fakeBroker('paper_only', { paperTrading: true, liveTrading: false }));

    const { LIVE_TRADING_CONFIRMATION_PHRASE } = await import('../server/core/LiveTradingConfirmation');
    const result = await manager.setLiveMode('paper_only', true, LIVE_TRADING_CONFIRMATION_PHRASE);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not support live trading/i);
  });

  it('refuses to switch to PAPER for a broker whose capabilities say paperTrading:false', async () => {
    const manager = BrokerManager.getInstance();
    manager.registerBroker(fakeBroker('live_only', { paperTrading: false, liveTrading: true }));

    const result = await manager.setLiveMode('live_only', false);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not support paper trading/i);
  });

  it('allows switching to LIVE for a broker that genuinely supports it, with the real confirmation phrase', async () => {
    const manager = BrokerManager.getInstance();
    manager.registerBroker(fakeBroker('full_support', { paperTrading: true, liveTrading: true }));

    const { LIVE_TRADING_CONFIRMATION_PHRASE } = await import('../server/core/LiveTradingConfirmation');
    const result = await manager.setLiveMode('full_support', true, LIVE_TRADING_CONFIRMATION_PHRASE);

    expect(result.ok).toBe(true);
    const [conn] = await db.select().from(schema.brokerConnections).where(eq(schema.brokerConnections.brokerName, 'Fake full_support'));
    expect(conn.paperMode).toBe(false);
  });

  it('allows switching back to PAPER for a broker that supports both modes', async () => {
    const manager = BrokerManager.getInstance();
    manager.registerBroker(fakeBroker('full_support_2', { paperTrading: true, liveTrading: true }));

    const result = await manager.setLiveMode('full_support_2', false);
    expect(result.ok).toBe(true);
  });

  it('still refuses live mode for a NON_FUNCTIONAL_BROKER_ID (questrade) before the capability check even runs', async () => {
    const manager = BrokerManager.getInstance();
    // The real QuestradeBroker isn't registered in this test (that only happens via
    // initialize(), which this test deliberately avoids to skip its real auth side effects) - a
    // fake registered under the same id is enough, since NON_FUNCTIONAL_BROKER_IDS matches on id
    // alone, regardless of which class implements it.
    manager.registerBroker(fakeBroker('questrade', { paperTrading: false, liveTrading: false }));

    const { LIVE_TRADING_CONFIRMATION_PHRASE } = await import('../server/core/LiveTradingConfirmation');
    const result = await manager.setLiveMode('questrade', true, LIVE_TRADING_CONFIRMATION_PHRASE);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unimplemented/i);
  });
});
