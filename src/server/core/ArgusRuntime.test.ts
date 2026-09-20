import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { existsSync, unlinkSync } from 'node:fs';

describe('ArgusRuntime lifecycle', () => {
  it('does not call a selected, synchronized but unauthenticated Gateway ready', async () => {
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    const { argusRuntime } = await import('./ArgusRuntime');
    const manager = BrokerManager.getInstance();
    const health = vi.fn(async () => 'Healthy');
    vi.spyOn(manager, 'isReadyForReconciliation').mockReturnValue(true);
    vi.spyOn(manager, 'getActiveBroker').mockReturnValue({ id: 'ibkr_gateway', getConnectionSnapshot: () => ({ authenticated: false }), health } as any);
    expect(await argusRuntime.brokerReadiness()).toEqual({ ready: false, detail: 'ibkr_gateway: session not authenticated' });
    expect(health).not.toHaveBeenCalled();
  });

  it('requires actual broker health as well as authenticated synchronized state', async () => {
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    const { argusRuntime } = await import('./ArgusRuntime');
    const manager = BrokerManager.getInstance();
    const health = vi.fn(async () => 'Offline');
    vi.spyOn(manager, 'isReadyForReconciliation').mockReturnValue(true);
    vi.spyOn(manager, 'getActiveBroker').mockReturnValue({ id: 'ibkr_gateway', getConnectionSnapshot: () => ({ authenticated: true }), health } as any);
    expect((await argusRuntime.brokerReadiness()).ready).toBe(false);
    health.mockResolvedValue('Healthy');
    expect((await argusRuntime.brokerReadiness()).ready).toBe(true);
    // Web wrapper exposes mode/id only; its health method owns authentication evidence.
    vi.spyOn(manager, 'getActiveBroker').mockReturnValue({ id: 'ibkr_web', getConnectionSnapshot: () => ({ mode: 'web' }), health } as any);
    expect((await argusRuntime.brokerReadiness()).ready).toBe(true);
  });
  let tmpDb: string;
  let tmpSessionPath: string;

  beforeEach(async () => {
    tmpDb = path.join(os.tmpdir(), `argus_runtime_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDb;
    // P1 isolation fix (2026-09-15) - this test boots the real core (via ArgusRuntime.initialize())
    // without going through ArgusCoreBoot.test.ts's own beforeAll, so it never isolated
    // sessionRecovery's file path - a real, confirmed incident (see
    // productionRuntimePathGuard.ts's own header): running this test while a real engine was live
    // silently touched the real data/.argus_runtime_session.json file. Same fix pattern
    // ArgusCoreBoot.test.ts already established.
    tmpSessionPath = path.join(os.tmpdir(), `argus_runtime_session_${Date.now()}_${process.pid}.json`);
    const { setSessionRecoveryPathForTests } = await import('./sessionRecovery');
    setSessionRecoveryPathForTests(tmpSessionPath);
    const { resetArgusCoreBootedForTests } = await import('./ArgusCoreBoot');
    resetArgusCoreBootedForTests();
    const { argusRuntime } = await import('./ArgusRuntime');
    argusRuntime.resetForTests();
  });

  it('initialize transitions STOPPED → RUNNING without Express', async () => {
    const { argusRuntime } = await import('./ArgusRuntime');
    expect(argusRuntime.getSnapshot().phase).toBe('STOPPED');
    await argusRuntime.initialize();
    expect(argusRuntime.getSnapshot().phase).toMatch(/RUNNING|SAFE_MODE/);
    const health = argusRuntime.health();
    expect(health.coreBooted).toBe(true);
    // R4 diagnostic-logging fix (2026-09-07): health() must surface enough of
    // MarketDataWorker.getFeedStatus() to actually diagnose a marketDataConnected:false report,
    // not just the bare boolean the Sept-6 audit found insufficient.
    expect(typeof health.marketDataAuthenticated).toBe('boolean');
    expect(health.marketDataLastError === null || typeof health.marketDataLastError === 'string').toBe(true);
    expect(health.marketDataReadyState === null || typeof health.marketDataReadyState === 'number').toBe(true);
  }, 60_000);

  it('stop pauses trading without throwing', async () => {
    const { argusRuntime } = await import('./ArgusRuntime');
    await argusRuntime.initialize();
    const result = await argusRuntime.stop({ reason: 'test', actor: 'test' });
    expect(result.ok).toBe(true);
    expect(argusRuntime.getSnapshot().phase).toMatch(/SAFE_MODE|STOPPING|STOPPED/);
  }, 60_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    if (existsSync(tmpDb)) {
      try { unlinkSync(tmpDb); } catch { /* ignore */ }
      try { unlinkSync(`${tmpDb}-wal`); } catch { /* ignore */ }
      try { unlinkSync(`${tmpDb}-shm`); } catch { /* ignore */ }
    }
    delete process.env.ARGUS_DB_PATH;
    const { resetSessionRecoveryForTests } = await import('./sessionRecovery');
    resetSessionRecoveryForTests();
    if (existsSync(tmpSessionPath)) {
      try { unlinkSync(tmpSessionPath); } catch { /* ignore */ }
    }
  });
});
