/**
 * Single explicit Argus runtime lifecycle — coordinates boot state without duplicating
 * RiskEngine, OMS, BrokerManager, or trading logic.
 */
import { bootArgusCore, isArgusCoreBooted } from './ArgusCoreBoot';
import { isApiEnabled, isArgusEngineDaemon, isArgusHeadless, isWebUiEnabled } from '../app/runtimeConfig';
import { tradingEngine } from '../engines/TradingEngine';
import { system } from './SystemBootstrap';
import { marketDataWorker } from '../services/MarketDataWorker';
import { BrokerManager } from '../../brokers/BrokerManager';
import { evaluateLiveReadiness } from './liveReadinessEngine';
import { getPipelineAgentSnapshot } from './pipelineAgentSnapshot';

export type ArgusRuntimePhase =
  | 'STOPPED'
  | 'STARTING'
  | 'RUNNING'
  | 'STOPPING'
  | 'FAILED'
  | 'SAFE_MODE';

export interface ArgusRuntimeSnapshot {
  phase: ArgusRuntimePhase;
  coreBootedAt: string | null;
  headless: boolean;
  engineDaemon: boolean;
  webUiEnabled: boolean;
  apiEnabled: boolean;
  bootError: string | null;
  pid: number;
  uptimeMs: number;
}

export interface ArgusRuntimeHealth {
  ok: boolean;
  phase: ArgusRuntimePhase;
  coreBooted: boolean;
  tradingState: string;
  autobotEnabled: boolean;
  emergencyStopActive: boolean;
  marketDataConnected: boolean;
  brokerId: string | null;
  pipelineRunning: boolean;
  liveReadiness: string;
  safeMode: boolean;
  pid: number;
  uptimeMs: number;
  engineDaemon: boolean;
}

export class ArgusRuntime {
  private static instance: ArgusRuntime;
  private phase: ArgusRuntimePhase = 'STOPPED';
  private coreBootedAt: string | null = null;
  private bootError: string | null = null;

  static getInstance(): ArgusRuntime {
    if (!ArgusRuntime.instance) {
      ArgusRuntime.instance = new ArgusRuntime();
    }
    return ArgusRuntime.instance;
  }

  /** Reset for unit tests only. */
  resetForTests(): void {
    this.phase = isArgusCoreBooted() ? 'RUNNING' : 'STOPPED';
    this.coreBootedAt = null;
    this.bootError = null;
  }

  getSnapshot(): ArgusRuntimeSnapshot {
    return {
      phase: this.derivePhase(),
      coreBootedAt: this.coreBootedAt,
      headless: isArgusHeadless(),
      engineDaemon: isArgusEngineDaemon(),
      webUiEnabled: isWebUiEnabled(),
      apiEnabled: isApiEnabled(),
      bootError: this.bootError,
      pid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1000),
    };
  }

  private derivePhase(): ArgusRuntimePhase {
    if (this.phase === 'FAILED') return 'FAILED';
    if (this.phase === 'STARTING') return 'STARTING';
    if (this.phase === 'STOPPING') return 'STOPPING';
    if (!isArgusCoreBooted() && this.phase !== 'RUNNING') return 'STOPPED';
    if (
      tradingEngine.state.emergencyStopActive
      || tradingEngine.state.tradingState !== 'TRADING_ENABLED'
    ) {
      return 'SAFE_MODE';
    }
    return this.phase === 'RUNNING' || isArgusCoreBooted() ? 'RUNNING' : 'STOPPED';
  }

  /** Engine-only initialize — no Express/Vite/WebSocket. Idempotent. */
  async initialize(): Promise<void> {
    if (this.phase === 'RUNNING' || isArgusCoreBooted()) {
      this.phase = 'RUNNING';
      return;
    }
    this.phase = 'STARTING';
    this.bootError = null;
    try {
      await bootArgusCore();
      this.coreBootedAt = new Date().toISOString();
      this.phase = 'RUNNING';
    } catch (e: unknown) {
      this.phase = 'FAILED';
      this.bootError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  /** Alias for initialize — runtime is live after core boot. */
  async start(): Promise<void> {
    return this.initialize();
  }

  /**
   * Safe runtime stop: pause trading + disable Autobot + stop pipeline workers.
   * Does NOT exit the Node process (HTTP/API may remain up for observability).
   */
  async stop(opts: { reason?: string; actor?: string } = {}): Promise<{ ok: boolean; error?: string }> {
    if (this.phase === 'STOPPED' && !isArgusCoreBooted()) {
      return { ok: true };
    }
    this.phase = 'STOPPING';
    const reason = opts.reason ?? 'Runtime stop requested';
    const actor = opts.actor ?? 'ArgusRuntime';
    try {
      if (tradingEngine.state.enabled) {
        await tradingEngine.toggle({ enabled: false });
      }
      if (tradingEngine.state.tradingState === 'TRADING_ENABLED') {
        await tradingEngine.setTradingState('TRADING_PAUSED', { reason, actor });
      }
      system.stop();
      this.phase = 'SAFE_MODE';
      return { ok: true };
    } catch (e: unknown) {
      this.phase = 'FAILED';
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  status() {
    const sys = system.getStatus();
    return {
      runtime: this.getSnapshot(),
      system: sys,
      autobot: {
        enabled: tradingEngine.state.enabled,
        autoBotEnabled: tradingEngine.state.enabled,
        tradingMode: tradingEngine.state.tradingMode,
        tradingState: tradingEngine.state.tradingState,
        emergencyStopActive: tradingEngine.state.emergencyStopActive,
        budget: tradingEngine.state.budget,
        scheduleWindow: tradingEngine.getScheduleWindowStatus(),
      },
      consistent: sys.running === tradingEngine.state.enabled,
      liveReadiness: evaluateLiveReadiness().result,
      pipelineAgents: getPipelineAgentSnapshot(),
    };
  }

  health(): ArgusRuntimeHealth {
    const feed = marketDataWorker.getFeedStatus();
    let brokerId: string | null = null;
    try {
      brokerId = BrokerManager.getInstance().getActiveBroker()?.id ?? null;
    } catch {
      brokerId = null;
    }
    const phase = this.derivePhase();
    const safeMode = phase === 'SAFE_MODE' || tradingEngine.state.emergencyStopActive;
    return {
      ok: isArgusCoreBooted() && this.phase !== 'FAILED',
      phase,
      coreBooted: isArgusCoreBooted(),
      tradingState: tradingEngine.state.tradingState,
      autobotEnabled: tradingEngine.state.enabled,
      emergencyStopActive: tradingEngine.state.emergencyStopActive,
      marketDataConnected: feed.connected,
      brokerId,
      pipelineRunning: system.getStatus().running,
      liveReadiness: evaluateLiveReadiness().result,
      safeMode,
      pid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1000),
      engineDaemon: isArgusEngineDaemon(),
    };
  }
}

export const argusRuntime = ArgusRuntime.getInstance();
