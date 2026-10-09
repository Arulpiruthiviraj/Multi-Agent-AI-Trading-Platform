/**
 * Restart-action helpers for the external liveness watchdog (scripts/argusWatchdog.ts).
 *
 * Kept in this separate, importable module (rather than inline in the watchdog script) so the
 * two safety-critical properties below are unit-testable without spawning a real process:
 *
 * 1. NEVER AUTO-ENABLE TRADING: a watchdog-initiated restart must NEVER clear TRADING_PAUSED,
 *    release a safety pause, resolve a broker mismatch, or change thresholds. The ONLY command
 *    the watchdog may run is `argus-cli start` with NO `--enable-trading` flag. Boot restores
 *    the persisted tradingState as-is (TradingEngine.initialize), and evaluateRestartSafety()
 *    can only force-pause (never unpause) after an unclean shutdown. buildRestartSpawnSpec()
 *    is asserted by tests to contain no trading-resume flag.
 *
 * 2. SINGLE-ENGINE COORDINATION: the watchdog must never start a second engine while one holds
 *    the atomic startup claim (claimEnginePid's O_EXCL write in src/server/app/enginePid.ts -
 *    the 2026-10-08 P0 fix, verified across 6 real two-process races). shouldAttemptEngineSpawn()
 *    reconciles the pid file immediately before spawning: a live PID on the claim means the
 *    SIGKILL didn't take effect (or the process is mid-shutdown) and spawning anyway would risk
 *    two engines on one DB/broker. `argus-cli start` itself ALSO refuses in that case - this is
 *    defense in depth at the watchdog layer, with a clearer log line for forensics.
 */
import { join } from 'node:path';
import { reconcileEnginePidFile } from '../../src/server/app/enginePid';

export interface RestartSpawnSpec {
  execPath: string;
  args: string[];
  cwd: string;
}

/** The exact child-process invocation the watchdog uses to restart a dead/frozen engine. */
export function buildRestartSpawnSpec(root: string): RestartSpawnSpec {
  return {
    execPath: process.execPath,
    args: [
      '--use-system-ca',
      join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join(root, 'scripts', 'argus-cli.ts'),
      'start',
    ],
    cwd: root,
  };
}

/** Asserts the restart spec can never resume trading on its own. Throws if violated. */
export function assertRestartSpecNeverResumesTrading(spec: RestartSpawnSpec): void {
  const forbidden = spec.args.filter(
    (a) => a === '--enable-trading' || a.startsWith('--enable-trading='),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `WATCHDOG SAFETY VIOLATION: restart spec contains trading-resume flag(s) ${forbidden.join(', ')} - ` +
      'a watchdog-initiated restart must never clear TRADING_PAUSED.',
    );
  }
}

export interface SpawnGateResult {
  ok: boolean;
  reason: string;
}

/**
 * Pre-spawn gate against the atomic startup claim. Never throws - a gate that cannot decide
 * fails closed (refuse to spawn) rather than risk a second engine.
 */
export function shouldAttemptEngineSpawn(): SpawnGateResult {
  let status: { running: boolean; pid: number | null; staleCleared: boolean };
  try {
    status = reconcileEnginePidFile();
  } catch (e: unknown) {
    return {
      ok: false,
      reason: `could not reconcile engine pid file (${(e as Error)?.message || e}) - refusing to spawn rather than risk a second engine`,
    };
  }
  if (status.running) {
    return {
      ok: false,
      reason: `engine pid file still names live pid ${status.pid} (atomic startup claim held) - refusing to spawn a second engine`,
    };
  }
  return {
    ok: true,
    reason: status.staleCleared
      ? 'stale engine pid file was cleared; no live process holds the startup claim'
      : 'no engine pid file; no live process holds the startup claim',
  };
}
