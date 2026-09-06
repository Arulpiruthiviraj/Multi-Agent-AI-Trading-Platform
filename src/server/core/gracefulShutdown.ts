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
let registeredHandles: ShutdownHandles = {};

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
  // Real gap found and fixed this pass (2026-09-05, post-implementation forensic audit): none of
  // the workers below were ever stopped during drain, even though several of them (SessionLifecycle
  // most notably - a real DB write every ~60s, started independent of Autobot at core boot) keep
  // running on their own setInterval right up until sqliteDb.close() below. A tick landing after
  // close() throws "The database connection is not open"; if enough of these fire within the same
  // window, globalErrorHandlers.ts's own storm circuit-breaker (">4 in 5s") converts that into a
  // clean-but-unplanned process exit - reproduced live during this pass. Stopping every known
  // interval-driven worker BEFORE the DB closes, not after, is the correct fix - SystemBootstrap.stop()
  // and the three explicit stops above already cover most idea/execution agents; these are the
  // remainder (session/premarket, research/calibration, discovery, and optional campaign workers).
  try {
    const { sessionLifecycleWorker } = await import('../premarket/SessionLifecycle');
    sessionLifecycleWorker.stop();
  } catch (e) {
    console.error('[gracefulShutdown] Failed to stop SessionLifecycle', e);
  }
  try {
    const { javaQuantAdvisoryService } = await import('../services/JavaQuantAdvisoryService');
    javaQuantAdvisoryService.stop();
  } catch (e) {
    console.error('[gracefulShutdown] Failed to stop JavaQuantAdvisoryService', e);
  }
  try {
    const { calibrationValidationWorker } = await import('../continuous/CalibrationValidationWorker');
    calibrationValidationWorker.stop();
  } catch (e) {
    console.error('[gracefulShutdown] Failed to stop CalibrationValidationWorker', e);
  }
  try {
    const { marketUniverseScannerWorker } = await import('../continuous/MarketUniverseScanner');
    marketUniverseScannerWorker.stop();
  } catch (e) {
    console.error('[gracefulShutdown] Failed to stop MarketUniverseScanner', e);
  }
  try {
    const { campaignTracker } = await import('../services/CampaignTracker');
    campaignTracker.stop(); // also stops campaignWatchlistBoostWorker and campaignOpeningSurgeWorker internally
  } catch (e) {
    console.error('[gracefulShutdown] Failed to stop CampaignTracker', e);
  }
  try {
    const { autoTradeScheduler } = await import('../services/AutoTradeScheduler');
    autoTradeScheduler.stop();
  } catch (e) {
    console.error('[gracefulShutdown] Failed to stop AutoTradeScheduler', e);
  }
  try {
    const { marketOpenNewsConfluence } = await import('../news/MarketOpenNewsConfluence');
    marketOpenNewsConfluence.stop();
  } catch (e) {
    console.error('[gracefulShutdown] Failed to stop MarketOpenNewsConfluence', e);
  }
  try {
    const { strategyEngineShadowRunner } = await import('../services/StrategyEngineShadowRunner');
    strategyEngineShadowRunner.stop();
  } catch (e) {
    console.error('[gracefulShutdown] Failed to stop StrategyEngineShadowRunner', e);
  }
  try {
    const { openAliceVerificationService } = await import('../integrations/openalice/OpenAliceVerificationService');
    openAliceVerificationService.stopPolling();
  } catch (e) {
    console.error('[gracefulShutdown] Failed to stop OpenAliceVerificationService', e);
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
  registeredHandles = handles;
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

/**
 * DEF-26 fix (2026-08-26): `process.kill(pid, 'SIGTERM')` from a separate process — the CLI's
 * stop/restart path — does not invoke this process's `SIGTERM` handler on Windows at all;
 * empirically confirmed live (an isolated parent/child probe: the child process was force-
 * terminated with no handler invocation, both cross-process and via self-signal). Every prior
 * CLI-driven stop/restart on this platform was therefore an unconditional hard-kill, never a real
 * drain — which is exactly why the successor process's "did not shut down cleanly" report was
 * accurate, not a logging bug. This function lets an in-process HTTP route (same process, plain
 * function call, no OS signal involved) trigger the identical drain sequence the signal handler
 * above would have run, then exit — reusing the handles `installProcessShutdown` was given at
 * boot. `SIGTERM`/`SIGINT` listeners above are left installed unchanged (harmless, and still
 * correct on platforms where the OS signal is real).
 */
export async function requestGracefulShutdown(reason: string): Promise<void> {
  console.log(`[gracefulShutdown] Graceful shutdown requested (${reason}).`);
  await drainTradingProcess(registeredHandles);
  process.exit(0);
}

/** Test-only. */
export function resetGracefulShutdownForTests(): void {
  installed = false;
  draining = false;
  registeredHandles = {};
}
