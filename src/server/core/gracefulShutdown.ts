/**
 * SIGTERM/SIGINT drain: stop new trades, stop workers, close HTTP/WS (bounded wait for in-flight
 * requests to drain), THEN checkpoint/close SQLite.
 * Does not place or cancel broker orders (unknown in-flight stays PENDING for crash recovery).
 *
 * Real bug found and fixed (2026-09-08, live-reproduced): this used to close SQLite BEFORE closing
 * the HTTP server. DEF-27 (see below) fixed 9 interval-driven background workers ticking after
 * close() and throwing "database connection is not open" - but a live HTTP route can hit the exact
 * same failure: `close()` only stops accepting NEW connections, in-flight/polling requests (e.g. a
 * UI panel polling every 15-30s) keep being served and keep querying `db` until the server actually
 * finishes draining. Reproduced live: a 2026-09-07 22:28-22:36 crash.log burst of ~30
 * `TypeError: The database connection is not open` from `researchRoutes.ts`'s
 * `GET /research/vectorbt/status`, spanning the whole window between SQLite closing and the HTTP
 * server finishing its close() drain - enough to trip globalErrorHandlers.ts's own storm
 * circuit-breaker (">4 in 5s") into an unplanned exit. Fix: close WS then HTTP first (bounded by
 * `gracefulShutdownHttpDrainTimeoutMs`, tradingSafety.json, so a lingering keep-alive socket can
 * never hang shutdown - Node's `closeAllConnections()` force-closes whatever remains once the
 * timeout fires), and only then checkpoint/close SQLite - so no request can ever observe a closed DB.
 */
export interface ShutdownHandles {
  httpServer?: {
    close: (callback?: (err?: Error) => void) => unknown;
    closeAllConnections?: () => void;
  };
  wss?: { close: (callback?: (err?: Error) => void) => unknown };
}

/** Closes a handle, resolving either when its callback fires or when `timeoutMs` elapses -
 *  whichever comes first - so a lingering connection can never hang process shutdown. On timeout,
 *  calls `forceClose` (if given) to cut off whatever is left. */
async function closeWithTimeout(
  label: string,
  close: (callback?: (err?: Error) => void) => unknown,
  timeoutMs: number,
  forceClose?: () => void,
): Promise<void> {
  let settled = false;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.error(`[gracefulShutdown] ${label}.close() did not finish within ${timeoutMs}ms - forcing.`);
      try {
        forceClose?.();
      } catch (e) {
        console.error(`[gracefulShutdown] ${label} forceClose failed`, e);
      }
      resolve();
    }, timeoutMs);
    try {
      close(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.error(`[gracefulShutdown] ${label}.close() threw`, e);
      resolve();
    }
  });
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
    // R2 remediation (2026-09-06) - added after DEF-27's own lesson: stop every interval-driven
    // worker before sqliteDb.close() below, not after.
    const { stopHeartbeatWatchdog } = await import('./heartbeatWatchdog');
    stopHeartbeatWatchdog();
  } catch (e) {
    console.error('[gracefulShutdown] Failed to stop HeartbeatWatchdog', e);
  }
  // Close WS then HTTP BEFORE SQLite (see header comment) - bounded so an in-flight/keep-alive
  // connection can never hang shutdown, and so no late request can ever hit a closed DB.
  let drainTimeoutMs = 5000;
  try {
    const { tradingSafety } = await import('../config/tradingSafety');
    drainTimeoutMs = tradingSafety.gracefulShutdownHttpDrainTimeoutMs;
  } catch (e) {
    console.error('[gracefulShutdown] Failed to load tradingSafety config for drain timeout, using fallback', e);
  }
  if (handles.wss) {
    await closeWithTimeout('wss', handles.wss.close, drainTimeoutMs);
  }
  if (handles.httpServer) {
    await closeWithTimeout(
      'httpServer',
      handles.httpServer.close,
      drainTimeoutMs,
      handles.httpServer.closeAllConnections,
    );
  }
  try {
    const { sqliteDb } = await import('../db');
    sqliteDb.pragma('wal_checkpoint(TRUNCATE)');
    sqliteDb.close();
  } catch (e) {
    console.error('[gracefulShutdown] Failed to close SQLite', e);
  }
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
