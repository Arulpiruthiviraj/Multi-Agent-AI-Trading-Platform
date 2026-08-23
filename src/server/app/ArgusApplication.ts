/**
 * Application facade — single authoritative control surface for adapters (Web/API/CLI).
 * Delegates to existing services; contains no trading logic.
 */
import type { AutoBotState, TradingState } from '../engines/TradingEngine';
import { tradingEngine } from '../engines/TradingEngine';
import { argusRuntime } from '../core/ArgusRuntime';
import type { ArgusRuntimeSnapshot } from '../core/ArgusRuntime';
import { db } from '../db';
import { portfolio } from '../db/schema';
import { recentEvents as eventStoreRecent } from '../core/EventStore';

export class ArgusApplication {
  private static instance: ArgusApplication;

  static getInstance(): ArgusApplication {
    if (!ArgusApplication.instance) {
      ArgusApplication.instance = new ArgusApplication();
    }
    return ArgusApplication.instance;
  }

  /** Engine-only boot — no HTTP/Vite/WebSocket. Delegates to ArgusRuntime. */
  async bootCore(): Promise<void> {
    return argusRuntime.initialize();
  }

  getRuntimeSnapshot(): ArgusRuntimeSnapshot {
    return argusRuntime.getSnapshot();
  }

  /** Unified runtime status for CLI/Web/API. */
  status() {
    return argusRuntime.status();
  }

  health() {
    return argusRuntime.health();
  }

  async runtimeStop(opts: { reason?: string; actor?: string } = {}) {
    return argusRuntime.stop(opts);
  }

  /**
   * Authoritative Autobot enable/disable — always routes through TradingEngine.toggle().
   */
  async setAutobotEnabled(
    enabled: boolean,
    opts: { tradingMode?: string } = {},
  ): Promise<{ ok: boolean; error?: string }> {
    const { normalizeTradingMode } = await import('../core/tradingModeEnv');
    const payload: Partial<AutoBotState> & { enabled: boolean } = { enabled };
    if (opts.tradingMode != null) {
      payload.tradingMode = normalizeTradingMode(opts.tradingMode);
    }
    return tradingEngine.toggle(payload);
  }

  async enableTrading(
    config: Partial<AutoBotState> & { confirmLiveTrading?: string } = {},
  ): Promise<{ ok: boolean; error?: string }> {
    return tradingEngine.toggle({ ...config, enabled: true });
  }

  async disableTrading(): Promise<{ ok: boolean; error?: string }> {
    return tradingEngine.toggle({ enabled: false });
  }

  async setTradingState(
    newState: TradingState,
    opts: { reason: string; actor: string; cancelOpenOrders?: boolean },
  ) {
    return tradingEngine.setTradingState(newState, opts);
  }

  async positions() {
    return db.select().from(portfolio).all();
  }

  async recentTrades(limit = 50, brokerId?: string | null) {
    const { parseBrokerScopeQuery, resolveActiveBrokerId, listTradesForBrokerScope } = await import('../services/brokerScopedLedger');
    const parsed = parseBrokerScopeQuery(brokerId == null || brokerId === '' ? undefined : brokerId);
    if ('error' in parsed) throw new Error(parsed.error);
    const activeBrokerId = resolveActiveBrokerId(null);
    const scope = parsed.mode === 'broker' && !parsed.brokerId
      ? { mode: 'broker' as const, brokerId: activeBrokerId }
      : parsed;
    return listTradesForBrokerScope({ scope, activeBrokerId, limit });
  }

  /** Recent in-memory EventStore ring (not durable trace). */
  getRecentEvents(limit = 100) {
    return eventStoreRecent.slice(-limit);
  }
}

export const argusApplication = ArgusApplication.getInstance();
