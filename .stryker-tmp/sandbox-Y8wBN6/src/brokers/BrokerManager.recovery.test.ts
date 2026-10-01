// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrokerManager } from './BrokerManager';
import type { BrokerPlugin } from './BrokerAdapter';
import { portfolioReconciliationWorker } from '../server/services/PortfolioReconciliation';
import { allowsNewEntryIdeas, forceHoldNewEntryIdeasForTests, resetSessionRecoveryForTests, startSessionRecoveryListeners } from '../server/core/sessionRecovery';
import { tradingEngine } from '../server/engines/TradingEngine';
import { sqliteDb } from '../server/db';
import { AlpacaBroker } from './AlpacaBroker';
import { InternalPaperBroker } from './InternalPaperBroker';
import { QuestradeBroker } from './QuestradeBroker';
import { IBGatewaySocketAdapter } from './IBGatewaySocketAdapter';
import { InteractiveBrokersWebApiAdapter } from './InteractiveBrokersWebApiAdapter';
import { CoinbaseBroker } from './CoinbaseBroker';
import { CryptoPaperBroker } from './CryptoPaperBroker';

// Vitest setup isolates the DB. Real manager/reconciliation/session hold; only provider I/O
// and quote-backend binding are replaced. No injected MATCH and no synthetic runtime orders.
describe('BrokerManager recovery after failed startup', () => {
  const manager = BrokerManager.getInstance();
  let broker: BrokerPlugin;
  beforeEach(() => {
    vi.stubEnv('PAPER_TRADING_ONLY', 'true');
    vi.stubEnv('ARGUS_FORCE_ENV_BROKER_ON_BOOT', 'true');
    vi.stubEnv('ARGUS_ACTIVE_BROKER', 'alpaca');
    sqliteDb.exec('DELETE FROM trades; DELETE FROM portfolio; DELETE FROM reconciliation_events; DELETE FROM broker_connections;');
    resetSessionRecoveryForTests();
    startSessionRecoveryListeners();
    forceHoldNewEntryIdeasForTests(true);
    tradingEngine.state.tradingState = 'TRADING_PAUSED';
    manager.resetSyncStateForTests('FAILED');
    vi.spyOn(manager as any, 'applyMarketDataBinding').mockResolvedValue(undefined);
    vi.spyOn(manager as any, 'wireInternalPaperTicksFromMarketData').mockImplementation(() => {});
    broker = {
      id: 'recovery_fixture', name: 'Recovery fixture',
      initialize: vi.fn(async () => {}), authenticate: vi.fn(async () => true),
      validateCredentials: vi.fn(async () => true), paperTrading: vi.fn(), liveTrading: vi.fn(),
      getCapabilities: () => ({ canPlaceOrders: true, canCancelOrders: true, paperTrading: true,
        liveTrading: false, usEquities: true, canadianEquities: false, crypto: false, options: false,
        shortSelling: false, streamingMarketData: false, requiresManualReauth: false, extendedHoursOrders: false }),
      portfolio: vi.fn(async () => ({ cash: 1000, equity: 1000, buyingPower: 1000, positions: [] })),
      positions: vi.fn(async () => []), orders: vi.fn(async () => []), account: vi.fn(async () => ({})),
      health: vi.fn(async () => 'Healthy'), disconnect: vi.fn(async () => {}),
      placeOrder: vi.fn(async () => { throw new Error('No orders in recovery test'); }),
      cancelOrder: vi.fn(async () => false), closePosition: vi.fn(async () => false),
    };
    manager.registerBroker(broker);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetSessionRecoveryForTests();
    manager.resetSyncStateForTests();
    portfolioReconciliationWorker.resetFaultDebounceForTests();
  });

  it('admits real reconciliation after authentication and releases the restart hold only on its match', async () => {
    vi.mocked(broker.portfolio).mockImplementation(async () => {
      expect(manager.getSyncState()).toBe('SYNCING');
      expect(allowsNewEntryIdeas()).toBe(false);
      return { cash: 1000, equity: 1000, buyingPower: 1000, positions: [] };
    });
    await expect(manager.setActiveBroker(broker.id, { apiKey: 'fixture' })).resolves.toBe(true);
    expect(broker.portfolio).toHaveBeenCalledOnce();
    expect(manager.getSyncState()).toBe('READY');
    expect(allowsNewEntryIdeas()).toBe(true);
    expect(sqliteDb.prepare('SELECT matches FROM reconciliation_events').all()).toEqual([{ matches: 1 }]);
    expect(tradingEngine.state.tradingState).toBe('TRADING_PAUSED');
    expect(broker.placeOrder).not.toHaveBeenCalled();
  });

  it('keeps the hold on a real portfolio mismatch, despite successful authentication', async () => {
    vi.mocked(broker.portfolio).mockResolvedValue({ cash: 1000, equity: 3000, buyingPower: 1000, positions: [] });
    await manager.setActiveBroker(broker.id, { apiKey: 'fixture' });
    expect(allowsNewEntryIdeas()).toBe(false);
    expect(sqliteDb.prepare('SELECT matches FROM reconciliation_events').all()).toEqual([{ matches: 0 }]);
    expect(tradingEngine.state.tradingState).toBe('TRADING_PAUSED');
  });

  it('keeps the hold when the broker cannot return positions', async () => {
    vi.mocked(broker.portfolio).mockRejectedValue(new Error('provider unavailable'));
    await manager.setActiveBroker(broker.id, { apiKey: 'fixture' });
    expect(broker.portfolio).toHaveBeenCalledOnce();
    expect(allowsNewEntryIdeas()).toBe(false);
    expect(tradingEngine.state.tradingState).toBe('TRADING_PAUSED');
  });

  it('does not disconnect the old adapter or admit reconciliation on rejected authentication', async () => {
    const old = manager.getActiveBroker();
    const disconnect = vi.spyOn(old, 'disconnect').mockResolvedValue(undefined);
    vi.mocked(broker.authenticate).mockResolvedValue(false);
    await expect(manager.setActiveBroker(broker.id, { apiKey: 'fixture' })).rejects.toThrow(/authenticate/);
    expect(manager.getSyncState()).toBe('FAILED');
    expect(manager.getActiveBroker()).toBe(old);
    expect(disconnect).not.toHaveBeenCalled();
    expect(broker.portfolio).not.toHaveBeenCalled();
    expect(allowsNewEntryIdeas()).toBe(false);
  });

  it.each(['SYNCING', 'INITIALIZING'] as const)('refuses a cutover during %s', async state => {
    manager.resetSyncStateForTests(state);
    await expect(manager.setActiveBroker(broker.id, { apiKey: 'fixture' })).rejects.toThrow(/activation unavailable/);
    expect(manager.getSyncState()).toBe(state);
    expect(broker.authenticate).not.toHaveBeenCalled();
  });

  it('does not turn an invalid selection into a failure of the current broker', async () => {
    manager.resetSyncStateForTests('READY');
    await expect(manager.setActiveBroker('not_registered', { apiKey: 'fixture' })).rejects.toThrow(/not found/);
    expect(manager.getSyncState()).toBe('READY');
  });

  it('does not overlap activations or start reconciliation while authentication is pending', async () => {
    let finish!: (value: boolean) => void;
    vi.mocked(broker.authenticate).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const first = manager.setActiveBroker(broker.id, { apiKey: 'fixture' });
    expect(manager.isReadyForReconciliation()).toBe(false);
    await expect(manager.setActiveBroker(broker.id, { apiKey: 'fixture' })).rejects.toThrow(/activation unavailable/);
    expect(broker.authenticate).toHaveBeenCalledOnce();
    finish(true);
    await first;
    expect(manager.getSyncState()).toBe('READY');
  });

  it('treats a false boot authentication result as FAILED, never READY', async () => {
    for (const adapter of [AlpacaBroker, InternalPaperBroker, QuestradeBroker, IBGatewaySocketAdapter,
      InteractiveBrokersWebApiAdapter, CoinbaseBroker, CryptoPaperBroker]) {
      vi.spyOn(adapter.prototype, 'initialize').mockResolvedValue(undefined);
    }
    const authenticate = vi.spyOn(AlpacaBroker.prototype, 'authenticate').mockResolvedValue(false);
    await manager.initialize();
    expect(authenticate).toHaveBeenCalledOnce();
    expect(manager.getSyncState()).toBe('FAILED');
    expect(allowsNewEntryIdeas()).toBe(false);
  });
});
