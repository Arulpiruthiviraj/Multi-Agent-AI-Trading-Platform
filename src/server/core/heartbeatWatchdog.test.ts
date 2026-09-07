import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

/**
 * R2 (2026-09-06 post-audit remediation) - real coverage for heartbeatWatchdog.ts's silent-death
 * detection and its escalation into the real tradingEngine.setTradingState('TRADING_PAUSED', ...)
 * path (same pattern PortfolioReconciliation.tradingBlock.test.ts already proves for reconciliation
 * mismatches) - not just the pure evaluateHeartbeatWatchdog() predicate in isolation.
 */
const { isConnected } = vi.hoisted(() => ({ isConnected: vi.fn(() => true) }));
vi.mock('../services/MarketDataWorker', () => ({
  marketDataWorker: { isConnected },
}));

describe('heartbeatWatchdog', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let tradingEngine: any;
  let evaluateHeartbeatWatchdog: any;
  let resetHeartbeatWatchdogForTests: any;
  let notePipelineAgentTick: any;
  let resetPipelineAgentHealthForTests: any;
  let tradingSafety: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_heartbeat_watchdog_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ tradingEngine } = await import('../engines/TradingEngine'));
    ({ evaluateHeartbeatWatchdog, resetHeartbeatWatchdogForTests } = await import('./heartbeatWatchdog'));
    ({ notePipelineAgentTick, resetPipelineAgentHealthForTests } = await import('./pipelineAgentHealth'));
    ({ tradingSafety } = await import('../config/tradingSafety'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  beforeEach(() => {
    resetHeartbeatWatchdogForTests();
    resetPipelineAgentHealthForTests();
    isConnected.mockReset();
    isConnected.mockReturnValue(true);
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
  });

  it('does not suspect silent death when NewsAgent has ticked recently, regardless of MarketDataWorker connectivity', async () => {
    notePipelineAgentTick('NewsAgent');
    isConnected.mockReturnValue(false);

    const result = await evaluateHeartbeatWatchdog();

    expect(result.suspected).toBe(false);
  });

  it('does not suspect silent death when MarketDataWorker is connected, even if NewsAgent has gone silent', async () => {
    notePipelineAgentTick('NewsAgent');
    isConnected.mockReturnValue(true);
    const staleNow = Date.now() + tradingSafety.heartbeatWatchdogSilenceThresholdMs + 1000;

    const result = await evaluateHeartbeatWatchdog(staleNow);

    expect(result.suspected).toBe(false);
  });

  it('suspects silent death only when BOTH NewsAgent is silent past the threshold AND MarketDataWorker reports disconnected', async () => {
    notePipelineAgentTick('NewsAgent');
    isConnected.mockReturnValue(false);
    const staleNow = Date.now() + tradingSafety.heartbeatWatchdogSilenceThresholdMs + 1000;

    const result = await evaluateHeartbeatWatchdog(staleNow);

    expect(result.suspected).toBe(true);
  });

  it('never suspects silent death before NewsAgent has ticked even once (no false trigger during startup)', async () => {
    isConnected.mockReturnValue(false);
    const farFuture = Date.now() + tradingSafety.heartbeatWatchdogSilenceThresholdMs + 100000;

    const result = await evaluateHeartbeatWatchdog(farFuture);

    expect(result.newsAgentLastTickAt).toBeNull();
    expect(result.suspected).toBe(false);
  });

  it('a genuine silent-death verdict actually pauses trading via the real setTradingState() path, matching the reconciliation-mismatch precedent (never a second kill switch)', async () => {
    notePipelineAgentTick('NewsAgent');
    isConnected.mockReturnValue(false);
    const heartbeat = await import('./pipelineAgentHealth');
    const before = heartbeat.getPipelineAgentHeartbeat('NewsAgent').lastTickAt!;
    const staleNow = before + tradingSafety.heartbeatWatchdogSilenceThresholdMs + 1000;
    vi.useFakeTimers();
    vi.setSystemTime(staleNow);

    const heartbeatWatchdogModule = await import('./heartbeatWatchdog');
    const { runtimeIntervals } = await import('../config/runtimeIntervals');
    // Exercise the same private tick() path startHeartbeatWatchdog()'s interval would call, via
    // one real interval firing, rather than re-deriving/duplicating tick()'s own escalation logic.
    heartbeatWatchdogModule.startHeartbeatWatchdog();
    await vi.advanceTimersByTimeAsync(runtimeIntervals.heartbeatWatchdogCheckMs);
    heartbeatWatchdogModule.stopHeartbeatWatchdog();
    vi.useRealTimers();

    expect(tradingEngine.state.tradingState).toBe('TRADING_PAUSED');
    const [row] = await db.select().from(schema.killSwitchEvents).where(eq(schema.killSwitchEvents.actor, 'system:HeartbeatWatchdog'));
    expect(row).toBeTruthy();
    expect(row.toState).toBe('TRADING_PAUSED');
    expect(row.reason).toContain('NewsAgent silent');
  });

  it('never re-triggers or re-pauses a second time within the same process once already triggered', async () => {
    notePipelineAgentTick('NewsAgent');
    isConnected.mockReturnValue(false);
    const heartbeat = await import('./pipelineAgentHealth');
    const before = heartbeat.getPipelineAgentHeartbeat('NewsAgent').lastTickAt!;
    const staleNow = before + tradingSafety.heartbeatWatchdogSilenceThresholdMs + 1000;
    vi.useFakeTimers();
    vi.setSystemTime(staleNow);

    const heartbeatWatchdogModule = await import('./heartbeatWatchdog');
    const { runtimeIntervals } = await import('../config/runtimeIntervals');
    heartbeatWatchdogModule.startHeartbeatWatchdog();
    await vi.advanceTimersByTimeAsync(runtimeIntervals.heartbeatWatchdogCheckMs);
    expect(tradingEngine.state.tradingState).toBe('TRADING_PAUSED');

    // Operator (or a later, unrelated test) re-enables trading - the watchdog must not immediately
    // re-pause it again from the exact same still-stale condition (would be an unremovable trap).
    await tradingEngine.setTradingState('TRADING_ENABLED', { reason: 'test resume', actor: 'test' });
    await vi.advanceTimersByTimeAsync(runtimeIntervals.heartbeatWatchdogCheckMs);
    heartbeatWatchdogModule.stopHeartbeatWatchdog();
    vi.useRealTimers();

    expect(tradingEngine.state.tradingState).toBe('TRADING_ENABLED');
  });
});
