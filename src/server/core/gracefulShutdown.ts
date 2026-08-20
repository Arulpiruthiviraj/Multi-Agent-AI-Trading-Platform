/**
 * SIGTERM/SIGINT drain: stop new trades, stop workers, checkpoint/close SQLite, close HTTP/WS.
 * Does not place or cancel broker orders (unknown in-flight stays PENDING for crash recovery).
 */
export interface ShutdownHandles {
  httpServer?: { close: (callback?: (err?: Error) => void) => unknown };
  wss?: { close: (callback?: (err?: Error) => void) => unknown };
}

let installed = false;
let draining = false;

export async function drainTradingProcess(handles: ShutdownHandles = {}): Promise<void> {
  if (draining) return;
  draining = true;
  console.log('[gracefulShutdown] Stopping new trades and draining workers...');
  try {
    const { markCleanShutdown } = await import('./sessionRecovery');
    markCleanShutdown();
  } catch (e) {
    console.error('[gracefulShutdown] Failed to persist clean-shutdown marker', e);
  }
  try {
    const { clearEnginePid } = await import('../app/enginePid');
    clearEnginePid();
  } catch {
    /* pid file optional */
  }
  try {
    const { tradingEngine } = await import('../engines/TradingEngine');
    await tradingEngine.setTradingState('TRADING_PAUSED', {
      reason: 'Process shutdown drain — no new orders until restart recovery.',
      actor: 'gracefulShutdown',
    });
  } catch (e) {
    console.error('[gracefulShutdown] Failed to pause trading', e);
  }
  try {
    const { system } = await import('./SystemBootstrap');
    system.stop();
  } catch (e) {
    console.error('[gracefulShutdown] Failed to stop workers', e);
  }
  try {
    const { marketDataWorker } = await import('../services/MarketDataWorker');
    marketDataWorker.stop();
  } catch (e) {
    console.error('[gracefulShutdown] Failed to stop market data', e);
  }
  try {
    const { newsEngine } = await import('../news/NewsEngine');
    newsEngine.stop();
  } catch (e) {
    console.error('[gracefulShutdown] Failed to stop NewsEngine', e);
  }
  try {
    const { portfolioReconciliationWorker } = await import('../services/PortfolioReconciliation');
    portfolioReconciliationWorker.stop();
  } catch (e) {
    console.error('[gracefulShutdown] Failed to stop PortfolioReconciliation', e);
  }
  try {
    const { sqliteDb } = await import('../db');
    sqliteDb.pragma('wal_checkpoint(TRUNCATE)');
    sqliteDb.close();
  } catch (e) {
    console.error('[gracefulShutdown] Failed to close SQLite', e);
  }
  await new Promise<void>((resolve) => {
    if (!handles.wss) return resolve();
    try {
      handles.wss.close(() => resolve());
    } catch {
      resolve();
    }
  });
  await new Promise<void>((resolve) => {
    if (!handles.httpServer) return resolve();
    try {
      handles.httpServer.close(() => resolve());
    } catch {
      resolve();
    }
  });
  console.log('[gracefulShutdown] Drain complete.');
}

export function installProcessShutdown(handles: ShutdownHandles = {}): void {
  if (installed) return;
  installed = true;
  const onSignal = (signal: string) => {
    void drainTradingProcess(handles).finally(() => {
      process.exit(0);
    });
    console.log(`[gracefulShutdown] Received ${signal}`);
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
}

/** Test-only. */
export function resetGracefulShutdownForTests(): void {
  installed = false;
  draining = false;
}
