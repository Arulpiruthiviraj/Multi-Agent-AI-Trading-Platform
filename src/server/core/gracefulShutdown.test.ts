import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'node:fs';

vi.mock('../engines/TradingEngine', () => ({
  tradingEngine: { setTradingState: vi.fn(async () => {}) },
}));
vi.mock('./SystemBootstrap', () => ({
  system: { stop: vi.fn() },
}));
vi.mock('../services/MarketDataWorker', () => ({
  marketDataWorker: { stop: vi.fn() },
}));
vi.mock('../db', () => ({
  sqliteDb: { pragma: vi.fn(), close: vi.fn() },
}));

describe('gracefulShutdown drain', () => {
  const sessionPath = join(tmpdir(), `argus_shutdown_session_${process.pid}.json`);
  // Real bug found and fixed (2026-08-25): drainTradingProcess() calls the real, non-test-isolated
  // clearEnginePid() (via enginePid.ts) - without this override, every run of this test suite
  // deleted the actual developer-facing data/.argus_engine.pid, silently corrupting a real running
  // dev engine's pid tracking. Same isolation pattern as sessionPath above.
  const enginePidPath = join(tmpdir(), `argus_shutdown_engine_pid_${process.pid}.pid`);
  const originalEnginePidOverride = process.env.ARGUS_ENGINE_PID_PATH;

  beforeEach(async () => {
    process.env.ARGUS_ENGINE_PID_PATH = enginePidPath;
    const { resetGracefulShutdownForTests } = await import('./gracefulShutdown');
    const { resetSessionRecoveryForTests, setSessionRecoveryPathForTests } = await import('./sessionRecovery');
    resetGracefulShutdownForTests();
    resetSessionRecoveryForTests();
    setSessionRecoveryPathForTests(sessionPath);
  });

  afterEach(async () => {
    const { resetSessionRecoveryForTests } = await import('./sessionRecovery');
    resetSessionRecoveryForTests();
    try { unlinkSync(sessionPath); } catch { /* ignore */ }
    try { unlinkSync(enginePidPath); } catch { /* ignore */ }
    if (originalEnginePidOverride === undefined) delete process.env.ARGUS_ENGINE_PID_PATH;
    else process.env.ARGUS_ENGINE_PID_PATH = originalEnginePidOverride;
  });

  it('pauses trading, stops workers, checkpoints SQLite, and closes HTTP/WS handles', async () => {
    const { drainTradingProcess } = await import('./gracefulShutdown');
    const { tradingEngine } = await import('../engines/TradingEngine');
    const { system } = await import('./SystemBootstrap');
    const { marketDataWorker } = await import('../services/MarketDataWorker');
    const { sqliteDb } = await import('../db');
    const httpClose = vi.fn((cb?: (err?: Error) => void) => { cb?.(); });
    const wsClose = vi.fn((cb?: (err?: Error) => void) => { cb?.(); });

    await drainTradingProcess({ httpServer: { close: httpClose }, wss: { close: wsClose } });

    expect(tradingEngine.setTradingState).toHaveBeenCalledWith(
      'TRADING_PAUSED',
      expect.objectContaining({ reason: expect.stringMatching(/shutdown drain/i) }),
    );
    expect(system.stop).toHaveBeenCalled();
    expect(marketDataWorker.stop).toHaveBeenCalled();
    expect(sqliteDb.pragma).toHaveBeenCalledWith('wal_checkpoint(TRUNCATE)');
    expect(sqliteDb.close).toHaveBeenCalled();
    expect(httpClose).toHaveBeenCalled();
    expect(wsClose).toHaveBeenCalled();
    const { readFileSync } = await import('node:fs');
    const marker = JSON.parse(readFileSync(sessionPath, 'utf8'));
    expect(marker.cleanShutdown).toBe(true);
  });

  it('installProcessShutdown registers SIGTERM and SIGINT once', async () => {
    const onSpy = vi.spyOn(process, 'on');
    const { installProcessShutdown, resetGracefulShutdownForTests } = await import('./gracefulShutdown');
    resetGracefulShutdownForTests();
    installProcessShutdown();
    installProcessShutdown();
    expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    onSpy.mockRestore();
  });

  // DEF-26 (2026-08-26): process.kill(pid, 'SIGTERM') does not invoke this process's SIGTERM
  // handler on Windows (empirically confirmed live via an isolated parent/child probe) - every
  // prior CLI-driven stop/restart was an unconditional hard-kill, never a real drain, which is why
  // the successor's "did not shut down cleanly" report was accurate rather than a logging bug.
  // requestGracefulShutdown() is the fix: an in-process function call (triggered by the new
  // POST /api/v1/system/shutdown route, not an OS signal) that runs the identical drain sequence.
  describe('requestGracefulShutdown (DEF-26 fix)', () => {
    let exitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    });

    afterEach(() => {
      exitSpy.mockRestore();
    });

    it('reuses the handles installProcessShutdown was given at boot, runs the full drain, and exits cleanly — no OS signal involved', async () => {
      const { installProcessShutdown, requestGracefulShutdown, resetGracefulShutdownForTests } = await import('./gracefulShutdown');
      const { tradingEngine } = await import('../engines/TradingEngine');
      const { sqliteDb } = await import('../db');
      resetGracefulShutdownForTests();
      const httpClose = vi.fn((cb?: (err?: Error) => void) => { cb?.(); });
      const wsClose = vi.fn((cb?: (err?: Error) => void) => { cb?.(); });

      // Simulates server.ts's real boot call: installProcessShutdown({ httpServer, wss }).
      installProcessShutdown({ httpServer: { close: httpClose }, wss: { close: wsClose } });

      await requestGracefulShutdown('test: POST /api/v1/system/shutdown');

      expect(tradingEngine.setTradingState).toHaveBeenCalledWith('TRADING_PAUSED', expect.anything());
      expect(sqliteDb.pragma).toHaveBeenCalledWith('wal_checkpoint(TRUNCATE)');
      expect(httpClose).toHaveBeenCalled();
      expect(wsClose).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);

      const { readFileSync } = await import('node:fs');
      const marker = JSON.parse(readFileSync(sessionPath, 'utf8'));
      expect(marker.cleanShutdown).toBe(true);
    });

    it('does not require a SIGTERM/SIGINT listener to have fired - proves the fix does not depend on the broken OS-signal path at all', async () => {
      const onSpy = vi.spyOn(process, 'on');
      const { installProcessShutdown, requestGracefulShutdown, resetGracefulShutdownForTests } = await import('./gracefulShutdown');
      resetGracefulShutdownForTests();
      installProcessShutdown({});
      onSpy.mockClear();

      await requestGracefulShutdown('test: no signal involved');

      // The SIGTERM/SIGINT handlers registered at install time are never invoked by this path.
      expect(onSpy).not.toHaveBeenCalledWith('SIGTERM', expect.any(Function));
      expect(exitSpy).toHaveBeenCalledWith(0);
      onSpy.mockRestore();
    });
  });
});
