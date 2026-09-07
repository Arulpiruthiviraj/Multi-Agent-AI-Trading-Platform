#!/usr/bin/env node
/**
 * External Argus liveness watchdog. Run this as its own separate, long-lived process (its own
 * terminal, or a Windows Scheduled Task/service the operator registers themselves - this script
 * does not register itself as one, since that is an OS-level change outside this repo's scope).
 *
 * Why this exists: a 2026-09-07 readiness audit caught the real Argus engine dead - port 3000
 * unreachable, recorded PID no longer running, zero crash.log entry, zero Windows Application
 * event-log entry, cleanShutdown=false in the session file - with nothing to notice except a
 * human manually polling `argus-cli health`. `heartbeatWatchdog.ts` (in-process, added the same
 * week) cannot help here by its own design: it detects a worker silently dying while the process
 * lives, not the process itself disappearing - a dead process cannot watch itself. This script is
 * the missing OUTSIDE-the-process half.
 *
 * What it does, every poll interval:
 *   1. Read data/.argus_engine.pid and check the OS actually has a live process at that pid
 *      (enginePid.ts's isPidAlive - the same check the CLI itself already trusts).
 *   2. GET /ready and check it responds ok (unauthenticated by design - see checkHealth()).
 *   3. Read data/.argus_runtime_session.json for lastHeartbeatAt (written every 15s while the
 *      real engine is alive) and cleanShutdown (true only after a real graceful stop).
 *   4. Feed all three into the pure state machine in argusWatchdogLogic.ts, which decides:
 *      NONE / LOG_SUSPECT / RESTART / FORCE_KILL_AND_RESTART / ALERT_HALTED / RESUMED_HEALTHY.
 *   5. Write its OWN heartbeat file (data/logs/.argus_watchdog_heartbeat.json) every tick, so
 *      something can answer "is the watchdog itself still alive" - see StartupHealthRegistry.ts's
 *      'Watchdog' entry, surfaced through the same `argus-cli health`/`start` companion-services
 *      report Chronos/Ollama/etc already use. This does not solve the infinite-regress problem
 *      (nothing watches the watchdog's watcher) - it only means an operator checking Argus's own
 *      health, which the pre-session checklist already asks for, also sees whether its guardian is
 *      still ticking, instead of that being a second, separate, easy-to-forget thing to check.
 *
 * What it does NOT do:
 *   - Never opens data/argus.db (stays a true, separate, read-only-of-Argus-state observer).
 *   - Never calls a trading/resume endpoint. It only ever runs `argus-cli start`, which - already,
 *     independently, verified live in this repo's own audits - leaves tradingState at
 *     TRADING_PAUSED after any restart. Resuming trading after an unattended restart remains a
 *     deliberate, separate, operator-only action.
 *   - Only force-kills a live-but-unresponsive ("frozen") process after a much longer confirmation
 *     window (frozenConfirmTicks) than a confirmed-dead PID needs - see argusWatchdogLogic.ts's
 *     own doc comment on why a bounded force-kill is acceptable at all (SQLite WAL mode already
 *     tolerates a mid-write kill, the same recovery this system relies on for any unexpected
 *     death) and why the window is deliberately long (ruling out "merely slow", not truly stuck).
 *   - Never restarts without bound. A rolling max-restarts-per-window budget exists specifically
 *     to prevent a restart storm; once exhausted it halts and alerts instead of continuing to try.
 *
 * Config via env vars (all optional, sane defaults):
 *   ARGUS_WATCHDOG_POLL_MS            default 30000
 *   ARGUS_WATCHDOG_HEARTBEAT_STALE_MS default 60000
 *   ARGUS_WATCHDOG_CONFIRM_TICKS      default 2
 *   ARGUS_WATCHDOG_FROZEN_CONFIRM_TICKS default 10
 *   ARGUS_WATCHDOG_MAX_RESTARTS       default 3
 *   ARGUS_WATCHDOG_RESTART_WINDOW_MS  default 3600000 (1h)
 *   ARGUS_CLI_BASE_URL / BASE_URL     reused from argus-cli.ts's own convention (default http://127.0.0.1:3000)
 */
import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isPidAlive, readEnginePid } from '../src/server/app/enginePid';
import {
  initialStateMachine,
  nextState,
  DEFAULT_WATCHDOG_CONFIG,
  type WatchdogConfig,
  type StateMachine,
  type TickObservation,
} from './lib/argusWatchdogLogic';

const ROOT = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SESSION_PATH = join(ROOT, 'data', '.argus_runtime_session.json');
const LOG_PATH = join(ROOT, 'data', 'logs', 'watchdog.log');
const WATCHDOG_HEARTBEAT_PATH = join(ROOT, 'data', 'logs', '.argus_watchdog_heartbeat.json');
const BASE_URL = process.env.ARGUS_CLI_BASE_URL || process.env.BASE_URL || 'http://127.0.0.1:3000';

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const config: WatchdogConfig = {
  heartbeatStaleMs: numEnv('ARGUS_WATCHDOG_HEARTBEAT_STALE_MS', DEFAULT_WATCHDOG_CONFIG.heartbeatStaleMs),
  confirmTicks: numEnv('ARGUS_WATCHDOG_CONFIRM_TICKS', DEFAULT_WATCHDOG_CONFIG.confirmTicks),
  frozenConfirmTicks: numEnv('ARGUS_WATCHDOG_FROZEN_CONFIRM_TICKS', DEFAULT_WATCHDOG_CONFIG.frozenConfirmTicks),
  maxRestarts: numEnv('ARGUS_WATCHDOG_MAX_RESTARTS', DEFAULT_WATCHDOG_CONFIG.maxRestarts),
  restartWindowMs: numEnv('ARGUS_WATCHDOG_RESTART_WINDOW_MS', DEFAULT_WATCHDOG_CONFIG.restartWindowMs),
};
const POLL_MS = numEnv('ARGUS_WATCHDOG_POLL_MS', 30_000);

function log(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, stamped + '\n', 'utf8');
  } catch {
    /* best-effort logging only - never let a log-write failure crash the watchdog itself */
  }
}

/** Best-effort, OS-native, dependency-free "push" alert to whoever is logged into this console -
 *  msg.exe ships with Windows and does not require any extra module. Silently no-ops on any
 *  failure (missing binary, non-interactive session, non-Windows) - an alert mechanism must never
 *  itself become a new failure mode. This does not replace real pager/notification integration for
 *  a production deployment; it is the smallest addition that makes RESTART_BUDGET_EXHAUSTED more
 *  visible than a log line alone, for a single-operator local desktop deployment.
 */
function alertOperator(message: string): void {
  if (process.platform !== 'win32') return;
  try {
    spawnSync('msg.exe', ['*', '/TIME:60', message], { timeout: 5_000, windowsHide: true });
  } catch {
    /* best-effort only */
  }
}

interface SessionFileShape {
  lastHeartbeatAt?: string;
  cleanShutdown?: boolean;
}

function readSessionFile(): SessionFileShape | null {
  try {
    if (!existsSync(SESSION_PATH)) return null;
    const raw = JSON.parse(readFileSync(SESSION_PATH, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return raw as SessionFileShape;
  } catch {
    return null;
  }
}

function writeWatchdogHeartbeat(state: string): void {
  try {
    mkdirSync(dirname(WATCHDOG_HEARTBEAT_PATH), { recursive: true });
    writeFileSync(WATCHDOG_HEARTBEAT_PATH, JSON.stringify({
      pid: process.pid,
      lastTickAt: new Date().toISOString(),
      state,
    }, null, 2), 'utf8');
  } catch {
    /* best-effort - a failure here must not crash the watchdog's real job */
  }
}

async function checkHealth(): Promise<boolean> {
  try {
    // /ready (server.ts), not /api/v2/runtime/health: the latter sits behind the same session-auth
    // gate every /api/* route uses, so an unauthenticated external watchdog always got 401 there
    // (caught live during this script's own controlled test - see the doc this script ships with).
    // /health and /ready are deliberately registered outside /api/ and unauthenticated by design,
    // for exactly this kind of external liveness probe. /ready is preferred over /health because it
    // also proves the one hard dependency every route needs (SQLite) is actually reachable, not just
    // that the HTTP server itself is up.
    const res = await fetch(`${BASE_URL}/ready`, { signal: AbortSignal.timeout(8_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function observe(): Promise<TickObservation> {
  const pid = readEnginePid();
  const pidAlive = pid !== null && isPidAlive(pid);
  const healthOk = await checkHealth();
  const session = readSessionFile();
  let heartbeatAgeMs: number | null = null;
  if (session?.lastHeartbeatAt) {
    const t = Date.parse(session.lastHeartbeatAt);
    heartbeatAgeMs = Number.isFinite(t) ? Date.now() - t : null;
  }
  const cleanShutdown = typeof session?.cleanShutdown === 'boolean' ? session.cleanShutdown : null;
  return { pidAlive, healthOk, heartbeatAgeMs, cleanShutdown };
}

function attemptRestart(reasonLabel: string): void {
  log(`${reasonLabel} -> running \`argus-cli start\`. This does NOT resume trading - the engine will boot to TRADING_PAUSED as always; an operator must explicitly resume.`);
  const result = spawnSync(process.execPath, ['--use-system-ca', join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ROOT, 'scripts', 'argus-cli.ts'), 'start'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180_000,
  });
  if (result.error) {
    log(`RESTART ATTEMPT FAILED to even spawn: ${result.error.message}`);
    return;
  }
  log(`RESTART ATTEMPT exit=${result.status} stdout(tail)=${(result.stdout || '').slice(-500)} stderr(tail)=${(result.stderr || '').slice(-500)}`);
}

/** Only reached after frozenConfirmTicks consecutive bad-but-pidAlive ticks - see
 *  argusWatchdogLogic.ts's WatchdogConfig doc comment for the safety reasoning. Uses the plain
 *  OS kill (SIGTERM first via Node's default, matching how an operator's Ctrl+C would behave);
 *  falls through to the restart path regardless of whether the kill itself reports success, since
 *  the very next observe() tick will re-check reality rather than trust this call's return value. */
function forceKillFrozenProcess(): void {
  const pid = readEnginePid();
  if (pid === null) {
    log('FROZEN_CONFIRMED but no pid on file to kill - proceeding straight to restart.');
    return;
  }
  log(`FROZEN_CONFIRMED (pid ${pid} alive but unresponsive for ${config.frozenConfirmTicks} consecutive ticks) -> force-killing before restart.`);
  try {
    process.kill(pid, 'SIGKILL');
  } catch (e: any) {
    log(`Force-kill of pid ${pid} failed (may have already exited): ${e?.message || e}`);
  }
}

async function tick(machine: StateMachine): Promise<StateMachine> {
  const obs = await observe();
  const { machine: nextMachine, action } = nextState(machine, obs, config, Date.now());

  switch (action) {
    case 'NONE':
      break;
    case 'RESUMED_HEALTHY':
      log('Recovered -> HEALTHY.');
      break;
    case 'LOG_SUSPECT':
      log(`SUSPECT (consecutiveBadTicks=${nextMachine.consecutiveBadTicks}/${obs.pidAlive ? config.frozenConfirmTicks : config.confirmTicks}) pidAlive=${obs.pidAlive} healthOk=${obs.healthOk} heartbeatAgeMs=${obs.heartbeatAgeMs}`);
      break;
    case 'RESTART':
      attemptRestart('CONFIRMED_DEAD (unexpected, cleanShutdown=false or unreadable)');
      break;
    case 'FORCE_KILL_AND_RESTART':
      forceKillFrozenProcess();
      attemptRestart('FROZEN_CONFIRMED');
      break;
    case 'ALERT_HALTED': {
      const msg = `CRITICAL: Argus watchdog restart budget exhausted (${config.maxRestarts} restarts within ${config.restartWindowMs}ms). NOT retrying automatically - operator attention required. Restart this watchdog process to reset the budget once the underlying issue is understood.`;
      log(msg);
      alertOperator(msg);
      break;
    }
  }

  if (nextMachine.state === 'STOPPED_INTENTIONALLY' && machine.state !== 'STOPPED_INTENTIONALLY') {
    log('Engine appears to have been stopped intentionally (cleanShutdown=true). Not restarting. Will resume watching in case it is started again.');
  }

  writeWatchdogHeartbeat(nextMachine.state);
  return nextMachine;
}

async function main(): Promise<void> {
  log(`Argus liveness watchdog starting. pollMs=${POLL_MS} config=${JSON.stringify(config)} baseUrl=${BASE_URL}`);
  let machine = initialStateMachine();
  writeWatchdogHeartbeat(machine.state);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      machine = await tick(machine);
    } catch (e: any) {
      log(`Unexpected error in watchdog tick (watchdog itself continues): ${e?.message || e}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main();
