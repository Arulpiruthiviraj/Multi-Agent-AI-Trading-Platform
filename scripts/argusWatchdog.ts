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
 *      real engine is alive), startedAt (engine boot time - for the startup grace window), and
 *      cleanShutdown (true only after a real graceful stop).
 *   4. Read data/.argus_maintenance_state.json for a FRESH, explicit maintenance claim
 *      (backup RUNNING, startup/shutdown in progress - see
 *      scripts/lib/watchdogMaintenanceState.ts). A stale or missing file is untrusted and
 *      ignored; deferral itself is time-bounded so a wedged maintenance still escalates.
 *   5. Feed all of the above into the pure state machine in argusWatchdogLogic.ts, which decides:
 *      NONE / LOG_SUSPECT / MAINTENANCE_DEFERRED / STARTUP_GRACE / COOLDOWN_WAIT /
 *      RESTART / FORCE_KILL_AND_RESTART / STORM_LOCKOUT / RESUMED_HEALTHY.
 *   6. Persist its own state (restart timestamps, storm lockout) to
 *      data/.argus_watchdog_state.json every tick, so a storm lockout survives watchdog
 *      restarts, and write its own heartbeat file
 *      (data/logs/.argus_watchdog_heartbeat.json) carrying the current decision counters.
 *
 * What it does NOT do:
 *   - Never opens data/argus.db (stays a true, separate, read-only-of-Argus-state observer).
 *   - Never calls a trading/resume endpoint. It only ever runs `argus-cli start` WITHOUT
 *     `--enable-trading` - which - already, independently, verified live in this repo's own
 *     audits - leaves tradingState at TRADING_PAUSED after any restart. Resuming trading after
 *     an unattended restart remains a deliberate, separate, operator-only action. The restart
 *     spec is asserted at runtime (argusWatchdogActions.assertRestartSpecNeverResumesTrading)
 *     to contain no trading-resume flag.
 *   - Never force-kills for "merely slow": force-kill needs frozenConfirmTicks consecutive
 *     bad ticks with the pid alive, and - since the 2026-10-08 defect #3 hardening - a fresh
 *     maintenance signal defers judgment entirely (up to a bounded deferral budget), and a
 *     startup-grace window covers boot. Killing mid-maintenance is what caused the restart
 *     storm; the storm is what STORM_LOCKOUT exists to stop.
 *   - Never restarts without bound. A rolling max-restarts-per-window budget with exponential
 *     backoff cooldowns exists specifically to prevent a restart storm; once exhausted it
 *     engages STORM_LOCKOUT - persisted to disk, requiring explicit operator action
 *     (`argus watchdog-clear-lockout`) to lift - instead of continuing to try.
 *   - Never starts a second engine: before spawning, it reconciles the engine pid file against
 *     the atomic startup claim (claimEnginePid's O_EXCL write) and refuses to spawn while a
 *     live process holds the claim. `argus-cli start` itself also refuses - this is defense in
 *     depth at the watchdog layer.
 *
 * Config: config/watchdog.json (all keys), each overridable via env var (sane defaults in the
 * JSON itself):
 *   ARGUS_WATCHDOG_POLL_MS                default 30000
 *   ARGUS_WATCHDOG_HEARTBEAT_STALE_MS     default 60000
 *   ARGUS_WATCHDOG_CONFIRM_TICKS          default 2
 *   ARGUS_WATCHDOG_FROZEN_CONFIRM_TICKS   default 10
 *   ARGUS_WATCHDOG_MAX_RESTARTS           default 3
 *   ARGUS_WATCHDOG_RESTART_WINDOW_MS      default 3600000 (1h)
 *   ARGUS_WATCHDOG_MAINTENANCE_FRESHNESS_MS   default 300000 (5min)
 *   ARGUS_WATCHDOG_MAINTENANCE_DEFERRAL_MAX_MS default 1800000 (30min)
 *   ARGUS_WATCHDOG_STARTUP_GRACE_MS       default 180000 (3min)
 *   ARGUS_WATCHDOG_RESTART_COOLDOWN_BASE_MS   default 120000 (2min)
 *   ARGUS_WATCHDOG_RESTART_COOLDOWN_MAX_MS   default 1800000 (30min)
 *   ARGUS_CLI_BASE_URL / BASE_URL     reused from argus-cli.ts's own convention (default http://127.0.0.1:3000)
 */
import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isPidAlive, readEnginePid } from '../src/server/app/enginePid';
import { assertNotProductionRuntimePath } from '../src/server/core/productionRuntimePathGuard';
import {
  initialStateMachine,
  nextState,
  seedStateMachineFromPersistence,
  DEFAULT_WATCHDOG_CONFIG,
  type WatchdogConfig,
  type StateMachine,
  type TickObservation,
  type WatchdogAction,
} from './lib/argusWatchdogLogic';
import {
  readMaintenanceSignal,
  type MaintenanceSignal,
} from './lib/watchdogMaintenanceState';
import {
  loadWatchdogState,
  saveWatchdogState,
  resolveWatchdogStatePath,
} from './lib/watchdogStateStore';
import {
  buildRestartSpawnSpec,
  assertRestartSpecNeverResumesTrading,
  shouldAttemptEngineSpawn,
} from './lib/argusWatchdogActions';

const ROOT = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SESSION_PATH = join(ROOT, 'data', '.argus_runtime_session.json');
const MAINTENANCE_PATH = process.env.ARGUS_MAINTENANCE_STATE_PATH?.trim()
  || join(ROOT, 'data', '.argus_maintenance_state.json');
const LOG_PATH = join(ROOT, 'data', 'logs', 'watchdog.log');
const WATCHDOG_HEARTBEAT_PATH = join(ROOT, 'data', 'logs', '.argus_watchdog_heartbeat.json');
const WATCHDOG_STATE_PATH = resolveWatchdogStatePath();
const BASE_URL = process.env.ARGUS_CLI_BASE_URL || process.env.BASE_URL || 'http://127.0.0.1:3000';

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Production thresholds come from config/watchdog.json (AGENTS.md hard rule); env vars override.
const config: WatchdogConfig = {
  heartbeatStaleMs: numEnv('ARGUS_WATCHDOG_HEARTBEAT_STALE_MS', DEFAULT_WATCHDOG_CONFIG.heartbeatStaleMs),
  confirmTicks: numEnv('ARGUS_WATCHDOG_CONFIRM_TICKS', DEFAULT_WATCHDOG_CONFIG.confirmTicks),
  frozenConfirmTicks: numEnv('ARGUS_WATCHDOG_FROZEN_CONFIRM_TICKS', DEFAULT_WATCHDOG_CONFIG.frozenConfirmTicks),
  maxRestarts: numEnv('ARGUS_WATCHDOG_MAX_RESTARTS', DEFAULT_WATCHDOG_CONFIG.maxRestarts),
  restartWindowMs: numEnv('ARGUS_WATCHDOG_RESTART_WINDOW_MS', DEFAULT_WATCHDOG_CONFIG.restartWindowMs),
  maintenanceFreshnessMs: numEnv('ARGUS_WATCHDOG_MAINTENANCE_FRESHNESS_MS', DEFAULT_WATCHDOG_CONFIG.maintenanceFreshnessMs),
  maintenanceDeferralMaxMs: numEnv('ARGUS_WATCHDOG_MAINTENANCE_DEFERRAL_MAX_MS', DEFAULT_WATCHDOG_CONFIG.maintenanceDeferralMaxMs),
  startupGraceMs: numEnv('ARGUS_WATCHDOG_STARTUP_GRACE_MS', DEFAULT_WATCHDOG_CONFIG.startupGraceMs),
  restartCooldownBaseMs: numEnv('ARGUS_WATCHDOG_RESTART_COOLDOWN_BASE_MS', DEFAULT_WATCHDOG_CONFIG.restartCooldownBaseMs),
  restartCooldownMaxMs: numEnv('ARGUS_WATCHDOG_RESTART_COOLDOWN_MAX_MS', DEFAULT_WATCHDOG_CONFIG.restartCooldownMaxMs),
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

/** Structured decision line for every watchdog tick: check -> verdict -> action -> reason, plus
 *  the diagnostic counters. Greppable as WATCHDOG_DECISION. */
function logDecision(
  action: WatchdogAction,
  reason: string,
  machine: StateMachine,
  obs: TickObservation,
  maintenance: MaintenanceSignal | null,
): void {
  const recentRestarts = machine.restartTimestamps.filter((t) => Date.now() - t <= config.restartWindowMs);
  log(`WATCHDOG_DECISION ${JSON.stringify({
    action,
    reason,
    state: machine.state,
    pidAlive: obs.pidAlive,
    healthOk: obs.healthOk,
    heartbeatAgeMs: obs.heartbeatAgeMs,
    cleanShutdown: obs.cleanShutdown,
    maintenance: maintenance ? maintenance.kind : null,
    consecutiveBadTicks: machine.consecutiveBadTicks,
    restartsInWindow: recentRestarts.length,
    maxRestarts: config.maxRestarts,
    lastRestartAt: machine.lastRestartAtMs !== null ? new Date(machine.lastRestartAtMs).toISOString() : null,
    stormLockout: machine.state === 'STORM_LOCKOUT',
  })}`);
}

/** Best-effort, OS-native, dependency-free "push" alert to whoever is logged into this console -
 *  msg.exe ships with Windows and does not require any extra module. Silently no-ops on any
 *  failure (missing binary, non-interactive session, non-Windows) - an alert mechanism must never
 *  itself become a new failure mode. This does not replace real pager/notification integration for
 *  a production deployment; it is the smallest addition that makes STORM_LOCKOUT more
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
  startedAt?: string;
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

function writeWatchdogHeartbeat(machine: StateMachine, lastAction: WatchdogAction): void {
  // Mechanical backstop (2026-09-15, P1) - see productionRuntimePathGuard.ts's own header for the
  // real incident history this class of check closes (a different file, same shape of gap, found
  // live this same day). Deliberately called BEFORE the try/catch below, not inside it - that
  // catch exists so a real filesystem failure never crashes the watchdog's own job, but a real
  // isolation violation must never be silently swallowed the same way. This script has no
  // test-only override for this path today because it is meant to run as a standalone process,
  // never imported - the isMainModule guard at the bottom of this file is the primary fix for
  // that; this call is defense in depth in case that ever changes.
  assertNotProductionRuntimePath(WATCHDOG_HEARTBEAT_PATH, 'watchdog heartbeat file', join(ROOT, 'data', 'logs', '.argus_watchdog_heartbeat.json'));
  const recentRestarts = machine.restartTimestamps.filter((t) => Date.now() - t <= config.restartWindowMs);
  try {
    mkdirSync(dirname(WATCHDOG_HEARTBEAT_PATH), { recursive: true });
    writeFileSync(WATCHDOG_HEARTBEAT_PATH, JSON.stringify({
      pid: process.pid,
      lastTickAt: new Date().toISOString(),
      state: machine.state,
      lastAction,
      consecutiveBadTicks: machine.consecutiveBadTicks,
      restartsInWindow: recentRestarts.length,
      maxRestarts: config.maxRestarts,
      lastRestartAt: machine.lastRestartAtMs !== null ? new Date(machine.lastRestartAtMs).toISOString() : null,
      stormLockout: machine.state === 'STORM_LOCKOUT',
      lockoutReason: machine.lockoutReason,
    }, null, 2), 'utf8');
  } catch {
    /* best-effort - a failure here must not crash the watchdog's real job */
  }
}

/** Persist restart history + storm lockout every tick (best-effort). This is what makes the
 *  storm lockout survive watchdog restarts. */
function persistWatchdogState(machine: StateMachine): void {
  assertNotProductionRuntimePath(WATCHDOG_STATE_PATH, 'watchdog state file', join(ROOT, 'data', '.argus_watchdog_state.json'));
  saveWatchdogState({
    schemaVersion: 1,
    restartTimestamps: machine.restartTimestamps,
    stormLockout: machine.state === 'STORM_LOCKOUT',
    stormLockoutReason: machine.lockoutReason || undefined,
    stormLockoutAt: machine.state === 'STORM_LOCKOUT' ? new Date().toISOString() : undefined,
    updatedAt: new Date().toISOString(),
  }, WATCHDOG_STATE_PATH);
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

async function observe(): Promise<{ obs: TickObservation; maintenance: MaintenanceSignal | null }> {
  const pid = readEnginePid();
  const pidAlive = pid !== null && isPidAlive(pid);
  const healthOk = await checkHealth();
  const session = readSessionFile();
  let heartbeatAgeMs: number | null = null;
  if (session?.lastHeartbeatAt) {
    const t = Date.parse(session.lastHeartbeatAt);
    heartbeatAgeMs = Number.isFinite(t) ? Date.now() - t : null;
  }
  let engineStartedAtMs: number | null = null;
  if (session?.startedAt) {
    const t = Date.parse(session.startedAt);
    engineStartedAtMs = Number.isFinite(t) ? t : null;
  }
  const cleanShutdown = typeof session?.cleanShutdown === 'boolean' ? session.cleanShutdown : null;
  // Maintenance signal: fresh, explicit "known maintenance is running" claim from the engine.
  // Missing/stale/malformed -> null -> the conservative escalation path applies unchanged.
  const maintenance = readMaintenanceSignal(MAINTENANCE_PATH, Date.now(), config.maintenanceFreshnessMs);
  const obs: TickObservation = {
    pidAlive,
    healthOk,
    heartbeatAgeMs,
    cleanShutdown,
    maintenance: maintenance ? { active: true, kind: maintenance.kind } : null,
    engineStartedAtMs,
  };
  return { obs, maintenance };
}

/**
 * Runs `argus-cli start` WITHOUT --enable-trading. Two safety gates before spawning:
 *  1. assertRestartSpecNeverResumesTrading - a watchdog-initiated restart must never clear
 *     TRADING_PAUSED, release a safety pause, resolve a broker mismatch, or change thresholds.
 *  2. shouldAttemptEngineSpawn - never start a second engine while one holds the atomic
 *     startup claim (a live PID on the pid file means the force-kill didn't take effect, or
 *     the process is mid-shutdown; `argus-cli start` itself would also refuse).
 */
function attemptRestart(reasonLabel: string): void {
  log(`${reasonLabel} -> running \`argus-cli start\` (WITHOUT --enable-trading). This does NOT resume trading - the engine will boot to TRADING_PAUSED as always; an operator must explicitly resume.`);
  const spec = buildRestartSpawnSpec(ROOT);
  try {
    assertRestartSpecNeverResumesTrading(spec);
  } catch (e: any) {
    log(`RESTART REFUSED: ${e?.message || e}`);
    return;
  }
  const gate = shouldAttemptEngineSpawn();
  if (!gate.ok) {
    log(`RESTART REFUSED (single-engine claim): ${gate.reason}. Will re-check next tick.`);
    return;
  }
  const result = spawnSync(spec.execPath, spec.args, {
    cwd: spec.cwd,
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

let lockoutAlertedThisBoot = false;

async function tick(machine: StateMachine): Promise<StateMachine> {
  const { obs, maintenance } = await observe();
  const { machine: nextMachine, action, reason } = nextState(machine, obs, config, Date.now());

  logDecision(action, reason, nextMachine, obs, maintenance);

  switch (action) {
    case 'NONE':
      if (nextMachine.state === 'STORM_LOCKOUT' && !lockoutAlertedThisBoot) {
        lockoutAlertedThisBoot = true;
        const msg = `CRITICAL: Argus watchdog is in STORM LOCKOUT (${nextMachine.lockoutReason || 'reason not recorded'}). NOT restarting automatically - operator attention required. Lift only after investigation with: argus watchdog-clear-lockout`;
        log(msg);
        alertOperator(msg);
      }
      break;
    case 'RESUMED_HEALTHY':
      log('Recovered -> HEALTHY.');
      break;
    case 'LOG_SUSPECT':
      log(`SUSPECT (consecutiveBadTicks=${nextMachine.consecutiveBadTicks}/${obs.pidAlive ? config.frozenConfirmTicks : config.confirmTicks}) pidAlive=${obs.pidAlive} healthOk=${obs.healthOk} heartbeatAgeMs=${obs.heartbeatAgeMs}`);
      break;
    case 'MAINTENANCE_DEFERRED':
      log(`Maintenance in progress (${maintenance?.kind || 'unknown'}) - deferring frozen/dead judgment. Stale heartbeat is expected during maintenance, not evidence of a freeze.`);
      break;
    case 'STARTUP_GRACE':
      log('Engine recently (re)started - deferring judgment until the startup grace window passes.');
      break;
    case 'COOLDOWN_WAIT':
      log('Restart needed but inside exponential-backoff cooldown - waiting rather than storm-restarting.');
      break;
    case 'RESTART':
      attemptRestart('CONFIRMED_DEAD (unexpected, cleanShutdown=false or unreadable)');
      break;
    case 'FORCE_KILL_AND_RESTART':
      forceKillFrozenProcess();
      attemptRestart('FROZEN_CONFIRMED');
      break;
    case 'STORM_LOCKOUT': {
      const msg = `CRITICAL: ${reason} Operator attention required. Lockout persisted to disk - restarting this watchdog will NOT clear it. Lift only after investigation with: argus watchdog-clear-lockout`;
      log(msg);
      alertOperator(msg);
      lockoutAlertedThisBoot = true;
      break;
    }
  }

  if (nextMachine.state === 'STOPPED_INTENTIONALLY' && machine.state !== 'STOPPED_INTENTIONALLY') {
    log('Engine appears to have been stopped intentionally (cleanShutdown=true). Not restarting. Will resume watching in case it is started again.');
  }

  persistWatchdogState(nextMachine);
  writeWatchdogHeartbeat(nextMachine, action);
  return nextMachine;
}

async function main(): Promise<void> {
  log(`Argus liveness watchdog starting. pollMs=${POLL_MS} config=${JSON.stringify(config)} baseUrl=${BASE_URL}`);
  const persisted = loadWatchdogState(WATCHDOG_STATE_PATH);
  let machine: StateMachine;
  if (persisted.stormLockout) {
    machine = seedStateMachineFromPersistence(persisted);
    log(`STORM LOCKOUT restored from persisted state (${persisted.stormLockoutReason || 'no reason recorded'} at ${persisted.stormLockoutAt || 'unknown time'}). NOT restarting automatically. Lift only after investigation with: argus watchdog-clear-lockout`);
  } else {
    machine = initialStateMachine();
    machine.restartTimestamps = persisted.restartTimestamps;
    if (persisted.restartTimestamps.length > 0) {
      machine.lastRestartAtMs = persisted.restartTimestamps[persisted.restartTimestamps.length - 1];
      log(`Restored ${persisted.restartTimestamps.length} prior restart timestamp(s) from persisted state - the storm budget survives watchdog restarts.`);
    }
  }
  writeWatchdogHeartbeat(machine, 'NONE');
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

// Real bug found and fixed (2026-09-15, P1 isolation pass - the same fix argus-cli.ts already
// needed for the identical reason): this used to call main() unconditionally at module load, with
// no guard distinguishing "invoked as `tsx argusWatchdog.ts`" from "imported for its exported pure
// functions". No test currently imports this file directly, so this was a LATENT risk, not yet a
// triggered incident - but a future test importing anything from this module (even just a type)
// would have started a real, infinite, file-writing/engine-restarting polling loop as a side
// effect of module load. Guarded the same way argus-cli.ts's own entry point already is.
const isMainModule = process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  main();
}
