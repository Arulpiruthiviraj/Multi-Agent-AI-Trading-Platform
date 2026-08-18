import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  beforeEach(async () => {
    const { resetGracefulShutdownForTests } = await import('./gracefulShutdown');
    resetGracefulShutdownForTests();
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
});
