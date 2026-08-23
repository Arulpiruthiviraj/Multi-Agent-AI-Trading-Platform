import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

  let prevPaperTradingOnly: string | undefined;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_brokermgr_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    prevPaperTradingOnly = process.env.PAPER_TRADING_ONLY;
    ({ db, sqliteDb } = await import('../server/db'));
    schema = await import('../server/db/schema');
    ({ BrokerManager } = await import('./BrokerManager'));
    // dotenv.config() during db import may re-apply developer PAPER_TRADING_ONLY — clear after.
    delete process.env.PAPER_TRADING_ONLY;
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
    if (prevPaperTradingOnly === undefined) delete process.env.PAPER_TRADING_ONLY;
    else process.env.PAPER_TRADING_ONLY = prevPaperTradingOnly;
  });

  it('refuses to switch to LIVE for a broker whose capabilities say liveTrading:false, even with the confirmation phrase', async () => {
    delete process.env.PAPER_TRADING_ONLY;
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
    delete process.env.PAPER_TRADING_ONLY;
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
    delete process.env.PAPER_TRADING_ONLY;
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

  it('throws when PAPER_TRADING_ONLY=true and LIVE is requested', async () => {
    const prev = process.env.PAPER_TRADING_ONLY;
    process.env.PAPER_TRADING_ONLY = 'true';
    try {
      const manager = BrokerManager.getInstance();
      manager.registerBroker(fakeBroker('pto_full', { paperTrading: true, liveTrading: true }));
      const { LIVE_TRADING_CONFIRMATION_PHRASE } = await import('../server/core/LiveTradingConfirmation');
      await expect(manager.setLiveMode('pto_full', true, LIVE_TRADING_CONFIRMATION_PHRASE))
        .rejects.toThrow(/Cannot enable LIVE mode when PAPER_TRADING_ONLY is enforced in environment/);
    } finally {
      if (prev === undefined) delete process.env.PAPER_TRADING_ONLY;
      else process.env.PAPER_TRADING_ONLY = prev;
    }
  });
});

describe('BrokerManager.setActiveBroker paper + IBKR preflight', () => {
  let tmpDbPath: string;
  let BrokerManager: any;
  let sqliteDb: any;
  let prevPaperTradingOnly: string | undefined;

  function fakeBroker(id: string, opts: Partial<BrokerCapabilities> & { healthResult?: string } = {}): BrokerPlugin {
    const { healthResult = 'Healthy', ...caps } = opts;
    return {
      id,
      name: id === 'ibkr' ? 'Interactive Brokers' : id === 'alpaca' ? 'Alpaca' : `Fake ${id}`,
      initialize: async () => {},
      authenticate: async () => true,
      validateCredentials: async () => true,
      paperTrading: () => {},
      liveTrading: () => {},
      getCapabilities: () => ({
        canPlaceOrders: true, canCancelOrders: true, paperTrading: true, liveTrading: true,
        usEquities: true, canadianEquities: false, crypto: false, options: false,
        shortSelling: false, streamingMarketData: false, requiresManualReauth: id === 'ibkr',
        ...caps,
      }),
      portfolio: async () => ({ cash: 0, buyingPower: 0, equity: 0, positions: [] }),
      orders: async () => [],
      positions: async () => [],
      account: async () => ({}),
      disconnect: async () => {},
      health: async () => healthResult,
      placeOrder: async () => { throw new Error('not used'); },
      cancelOrder: async () => false,
      closePosition: async () => false,
    };
  }

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_brokermgr_switch_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    prevPaperTradingOnly = process.env.PAPER_TRADING_ONLY;
    ({ sqliteDb } = await import('../server/db'));
    ({ BrokerManager } = await import('./BrokerManager'));
    delete process.env.PAPER_TRADING_ONLY;
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
    if (prevPaperTradingOnly === undefined) delete process.env.PAPER_TRADING_ONLY;
    else process.env.PAPER_TRADING_ONLY = prevPaperTradingOnly;
  });

  it('resolveBrokerIdFromSelectedName maps UI names and id aliases', () => {
    const manager = BrokerManager.getInstance();
    manager.registerBroker(fakeBroker('alpaca', {}));
    manager.registerBroker(fakeBroker('ibkr_gateway', {}));
    manager.registerBroker(fakeBroker('ibkr_web', {}));
    expect(manager.resolveBrokerIdFromSelectedName('Alpaca')).toBe('alpaca');
    expect(manager.resolveBrokerIdFromSelectedName('ibkr_gateway')).toBe('ibkr_gateway');
    expect(manager.resolveBrokerIdFromSelectedName('ibkr_web')).toBe('ibkr_web');
    expect(manager.resolveBrokerIdFromSelectedName('ibkr')).toBe('ibkr');
    expect(manager.resolveBrokerIdFromSelectedName('Interactive Brokers')).toBe('ibkr');
    expect(manager.resolveBrokerIdFromSelectedName('Simulation Mode')).toBe('internal_paper');
  });

  it('refuses IBKR Gateway switch when socket ports are closed', async () => {
    const probe = await import('./ibkrTcpProbe');
    const spy = vi.spyOn(probe, 'findFirstOpenTcpPort').mockResolvedValue(null);
    try {
      const manager = BrokerManager.getInstance();
      manager.registerBroker(fakeBroker('ibkr_gateway', { healthResult: 'Offline' }));
      await expect(manager.setActiveBroker('ibkr_gateway', { apiKey: 'x' }))
        .rejects.toThrow(/not reachable on port 4002\/7497|IB Gateway not reachable/i);
    } finally {
      spy.mockRestore();
    }
  });

  it('activates ibkr_gateway when socket preflight passes (paper under PAPER_TRADING_ONLY)', async () => {
    const probe = await import('./ibkrTcpProbe');
    const spy = vi.spyOn(probe, 'findFirstOpenTcpPort').mockResolvedValue(4002);
    const prev = process.env.PAPER_TRADING_ONLY;
    process.env.PAPER_TRADING_ONLY = 'true';
    try {
      const manager = BrokerManager.getInstance();
      let sawLive = false;
      const broker = fakeBroker('ibkr_gateway', { healthResult: 'Healthy' });
      (broker as any).name = 'IBKR Gateway (Socket)';
      const origLive = broker.liveTrading;
      broker.liveTrading = () => { sawLive = true; origLive(); };
      manager.registerBroker(broker);
      const ok = await manager.setActiveBroker('ibkr_gateway', { apiKey: 'x', isLive: true });
      expect(ok).toBe(true);
      expect(manager.getActiveBroker().id).toBe('ibkr_gateway');
      expect(sawLive).toBe(false);
    } finally {
      spy.mockRestore();
      if (prev === undefined) delete process.env.PAPER_TRADING_ONLY;
      else process.env.PAPER_TRADING_ONLY = prev;
    }
  });

  it('switches to alpaca without inventing a second order path (OMS still sole placeOrder)', async () => {
    const manager = BrokerManager.getInstance();
    manager.registerBroker(fakeBroker('alpaca', {}));
    const ok = await manager.setActiveBroker('alpaca', { apiKey: 'k', secretKey: 's' });
    expect(ok).toBe(true);
    expect(manager.getActiveBroker().id).toBe('alpaca');
  });
});
