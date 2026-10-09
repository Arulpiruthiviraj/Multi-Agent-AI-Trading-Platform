/**
 * Pure decision logic for the external Argus liveness watchdog (scripts/argusWatchdog.ts).
 *
 * Deliberately separated from all I/O (fs/http/child_process) so the state machine itself is
 * unit-testable without a real engine process. This process is NOT the trading engine and must
 * never import anything from src/server - it only reads the same plain files/HTTP endpoint an
 * operator would check by hand (data/.argus_engine.pid, data/.argus_runtime_session.json,
 * data/.argus_maintenance_state.json, GET /ready) and, on confirmed death, shells out to the
 * already-safe `argus-cli start` - it never opens data/argus.db and never calls a trading/resume
 * endpoint.
 *
 * Safety invariant this whole file exists to protect: this watchdog can restart a DEAD process,
 * but restarting is not the same as resuming trading. `argus-cli start`/`restart` already,
 * independently, always leaves tradingState at TRADING_PAUSED after any restart (verified live,
 * 2026-09-07 readiness audits) - this module has no code path that could bypass that, because it
 * never calls anything but the start command (see scripts/lib/argusWatchdogActions.ts, which
 * asserts the restart spec contains no trading-resume flag).
 *
 * 2026-10-08 defect #3 hardening (the restart storm): the pre-existing machine treated ANY stale
 * heartbeat + unresponsive /ready + live PID as a genuinely frozen process after a fixed
 * confirmation window, with no concept of known maintenance. A legitimate event-loop-blocking
 * maintenance (DB backup, V8 heap snapshot - the 2026-09-14 live kill documented in
 * docs/architecture/ARGUS_ARCHITECTURE.md P1-B - or a slow graceful drain) produces exactly the
 * same observable signature as a genuinely dead process, so the watchdog force-killed the engine
 * mid-maintenance; the restart re-ran the same maintenance, re-blocked, and each restart made
 * things worse. Three hardening layers, all in this file:
 *
 *  1. MAINTENANCE DEFERRAL: a fresh, explicit maintenance signal (backup RUNNING, startup or
 *     shutdown in progress - see scripts/lib/watchdogMaintenanceState.ts) defers ALL judgment
 *     while active, up to maintenanceDeferralMaxMs. Escalation counters freeze during deferral
 *     (neither incremented nor reset), so a genuinely stuck maintenance still escalates once its
 *     deferral budget is exhausted - deferral is bounded, never permanent. No signal, or a stale
 *     (untrusted) signal, means the old conservative path applies unchanged.
 *  2. STARTUP GRACE: a stale heartbeat with a live PID within startupGraceMs of the session
 *     file's startedAt is boot, not a freeze - escalation is deferred the same way.
 *  3. RESTART DISCIPLINE: cooldown between restarts with exponential backoff
 *     (delay = min(restartCooldownBaseMs * 2^restartsInWindow, restartCooldownMaxMs)), a max
 *     restarts budget inside a sliding window, and - on exceeding it - a STORM LOCKOUT: stop
 *     restarting entirely, leave the engine in its last state, persist the lockout to disk
 *     (data/.argus_watchdog_state.json, so it survives watchdog restarts), and require an
 *     explicit operator action (`argus watchdog-clear-lockout`) to lift. The old behavior of
 *     resetting the budget on watchdog restart is deliberately gone - that was the hole the
 *     storm escaped through.
 *
 * Fail closed everywhere: when in doubt, do NOT restart.
 */

import watchdogJson from '../../config/watchdog.json';

export type WatchdogState =
  | 'HEALTHY'
  | 'SUSPECT'
  | 'CONFIRMED_DEAD'
  | 'FROZEN_CONFIRMED'
  | 'RESTARTING'
  | 'STARTED'
  | 'STOPPED_INTENTIONALLY'
  | 'MAINTENANCE_DEFERRED'
  | 'STARTUP_GRACE'
  | 'COOLDOWN_WAIT'
  | 'STORM_LOCKOUT';

export type WatchdogAction =
  | 'NONE'
  | 'LOG_SUSPECT'
  | 'RESTART'
  | 'FORCE_KILL_AND_RESTART'
  | 'MAINTENANCE_DEFERRED'
  | 'STARTUP_GRACE'
  | 'COOLDOWN_WAIT'
  | 'STORM_LOCKOUT'
  | 'RESUMED_HEALTHY';

export interface TickObservation {
  /** Does the OS report this PID as alive right now (enginePid.ts's isPidAlive)? */
  pidAlive: boolean;
  /** Did GET /ready respond with HTTP ok this tick? */
  healthOk: boolean;
  /** Milliseconds since the session file's lastHeartbeatAt, or null if the file is unreadable. */
  heartbeatAgeMs: number | null;
  /** The session file's own cleanShutdown flag, or null if unreadable/missing. */
  cleanShutdown: boolean | null;
  /**
   * Maintenance signal from data/.argus_maintenance_state.json (see
   * scripts/lib/watchdogMaintenanceState.ts). Null/absent = no trusted maintenance claim -
   * the conservative escalation path applies unchanged.
   */
  maintenance?: { active: boolean; kind: string } | null;
  /**
   * ms-epoch of the session file's startedAt (engine boot time), or null if unreadable.
   * Used only for the startup grace window - never for any trading decision.
   */
  engineStartedAtMs?: number | null;
}

export interface WatchdogConfig {
  /** A tick counts as "bad" once heartbeat age exceeds this (independent of pidAlive/healthOk). */
  heartbeatStaleMs: number;
  /** Consecutive bad ticks required before moving SUSPECT -> CONFIRMED_DEAD (pid gone) or
   *  SUSPECT -> counting toward frozenConfirmTicks (pid alive but unresponsive). */
  confirmTicks: number;
  /**
   * Consecutive bad ticks (pid alive throughout) required before treating a live-but-unresponsive
   * process as frozen and force-killing it. Deliberately much larger than confirmTicks - this is a
   * more disruptive action than restarting an already-dead process, so it demands much stronger
   * evidence the process is genuinely stuck, not just briefly busy (e.g. a slow AI provider call,
   * a burst of discovery-candidate logging, GC pause). SQLite's WAL mode is designed to tolerate a
   * process being killed mid-write (replays/discards the incomplete transaction on next open) -
   * the same recovery this codebase already relies on for any unexpected death - so a bounded,
   * conservative force-kill here is not meaningfully riskier than a death this system already
   * handles, provided the confirmation window is long enough to rule out "merely slow."
   */
  frozenConfirmTicks: number;
  /** Max restarts allowed inside restartWindowMs before the storm lockout engages. Counts both a
   *  confirmed-dead restart and a forced frozen-process kill+restart against the same budget -
   *  both are equally disruptive recovery actions. */
  maxRestarts: number;
  restartWindowMs: number;
  /**
   * A maintenance signal older than this is untrusted (the publisher may be dead) and ignored -
   * deferral never outlives provably-live maintenance.
   */
  maintenanceFreshnessMs: number;
  /**
   * Maximum time judgment is deferred while a fresh maintenance signal stays active. After this
   * budget is exhausted, escalation resumes (a wedged backup is a real problem - fail closed
   * toward restart, not toward permanent blindness).
   */
  maintenanceDeferralMaxMs: number;
  /**
   * After a (re)start, a stale heartbeat with a live PID inside this window is boot, not a
   * freeze - escalation is deferred (counters frozen) until the window passes.
   */
  startupGraceMs: number;
  /**
   * Base cooldown between restarts; doubles with each restart inside the window
   * (delay = min(base * 2^restartsInWindow, restartCooldownMaxMs)).
   */
  restartCooldownBaseMs: number;
  /** Cap on the exponential restart backoff. */
  restartCooldownMaxMs: number;
}

function num(key: keyof WatchdogConfig, fallback: number): number {
  const raw = (watchdogJson as Record<string, unknown>)[key];
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Production thresholds come from config/watchdog.json (AGENTS.md hard rule: no hardcoded
 * operational/safety thresholds in TypeScript). Tests may spread-override individual fields.
 */
export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  heartbeatStaleMs: num('heartbeatStaleMs', 60_000),
  confirmTicks: num('confirmTicks', 2),
  frozenConfirmTicks: num('frozenConfirmTicks', 10),
  maxRestarts: num('maxRestarts', 3),
  restartWindowMs: num('restartWindowMs', 3_600_000),
  maintenanceFreshnessMs: num('maintenanceFreshnessMs', 300_000),
  maintenanceDeferralMaxMs: num('maintenanceDeferralMaxMs', 1_800_000),
  startupGraceMs: num('startupGraceMs', 180_000),
  restartCooldownBaseMs: num('restartCooldownBaseMs', 120_000),
  restartCooldownMaxMs: num('restartCooldownMaxMs', 1_800_000),
};

function isBadTick(obs: TickObservation, cfg: WatchdogConfig): boolean {
  if (!obs.pidAlive) return true;
  if (!obs.healthOk) return true;
  if (obs.heartbeatAgeMs === null) return true;
  if (obs.heartbeatAgeMs > cfg.heartbeatStaleMs) return true;
  return false;
}

export interface StateMachine {
  state: WatchdogState;
  /** Consecutive bad ticks observed since the last HEALTHY tick. */
  consecutiveBadTicks: number;
  /** Timestamps (ms epoch) of restarts this watchdog has performed, most recent last. */
  restartTimestamps: number[];
  /** When a fresh maintenance signal has been continuously active since (null when none). */
  maintenanceActiveSinceMs: number | null;
  /** When the last restart action was issued (null if none yet). Drives cooldown/backoff. */
  lastRestartAtMs: number | null;
  /** Set when entering STORM_LOCKOUT - persisted to disk by the I/O loop. */
  lockoutReason: string | null;
}

export function initialStateMachine(): StateMachine {
  return {
    state: 'HEALTHY',
    consecutiveBadTicks: 0,
    restartTimestamps: [],
    maintenanceActiveSinceMs: null,
    lastRestartAtMs: null,
    lockoutReason: null,
  };
}

/**
 * Seed a state machine from the persisted watchdog state (data/.argus_watchdog_state.json).
 * A persisted storm lockout re-enters STORM_LOCKOUT on boot - the lockout survives watchdog
 * restarts by design and only an explicit operator action lifts it.
 */
export function seedStateMachineFromPersistence(persisted: {
  restartTimestamps: number[];
  stormLockout: boolean;
  stormLockoutReason?: string;
}): StateMachine {
  const machine = initialStateMachine();
  machine.restartTimestamps = [...persisted.restartTimestamps];
  if (persisted.restartTimestamps.length > 0) {
    machine.lastRestartAtMs = persisted.restartTimestamps[persisted.restartTimestamps.length - 1];
  }
  if (persisted.stormLockout) {
    machine.state = 'STORM_LOCKOUT';
    machine.lockoutReason = persisted.stormLockoutReason || 'storm lockout restored from persisted state';
  }
  return machine;
}

function pruneOldRestarts(timestamps: number[], nowMs: number, windowMs: number): number[] {
  return timestamps.filter((t) => nowMs - t <= windowMs);
}

/**
 * Exponential backoff delay before the next restart is allowed, given how many restarts already
 * happened inside the sliding window. Pure - unit-testable. Grows as 2^n, capped.
 */
export function restartCooldownDelayMs(restartsInWindow: number, cfg: WatchdogConfig): number {
  const grown = cfg.restartCooldownBaseMs * Math.pow(2, Math.max(0, restartsInWindow));
  return Math.min(grown, cfg.restartCooldownMaxMs);
}

export interface NextStateResult {
  machine: StateMachine;
  action: WatchdogAction;
  /** Human-readable reason for the decision - the I/O loop logs this verbatim. */
  reason: string;
}

/**
 * Advance the state machine by one tick. Never mutates its input; returns the next state plus an
 * explicit `action` the caller (the real I/O loop) should take and a `reason` to log. This
 * function makes no I/O calls itself - it is pure and deterministic given its inputs, which is
 * what makes it unit-testable without a real process.
 */
export function nextState(
  machine: StateMachine,
  obs: TickObservation,
  cfg: WatchdogConfig,
  nowMs: number,
): NextStateResult {
  // Storm lockout is terminal for this watchdog process lifetime: it is never left
  // automatically. Only `argus watchdog-clear-lockout` (explicit operator action) lifts it.
  if (machine.state === 'STORM_LOCKOUT') {
    return {
      machine,
      action: 'NONE',
      reason: `storm lockout holds (${machine.lockoutReason || 'no reason recorded'}) - no automatic restart; operator action required`,
    };
  }

  const bad = isBadTick(obs, cfg);

  if (!bad) {
    const next: StateMachine = { ...machine, consecutiveBadTicks: 0, maintenanceActiveSinceMs: null };
    if (machine.state !== 'HEALTHY') {
      return {
        machine: { ...next, state: 'HEALTHY' },
        action: 'RESUMED_HEALTHY',
        reason: 'observations healthy again; escalation counters reset',
      };
    }
    return { machine: next, action: 'NONE', reason: 'healthy' };
  }

  // A fresh, explicit maintenance signal defers ALL judgment while active, up to a bounded
  // deferral budget. Escalation counters freeze during deferral (neither incremented nor
  // reset): a backup that finishes lets the next good tick clear everything, while a backup
  // that wedges past its deferral budget resumes escalation from where it left off.
  if (obs.maintenance?.active === true) {
    const activeSince = machine.maintenanceActiveSinceMs ?? nowMs;
    if (nowMs - activeSince <= cfg.maintenanceDeferralMaxMs) {
      return {
        machine: { ...machine, state: 'MAINTENANCE_DEFERRED', maintenanceActiveSinceMs: activeSince },
        action: 'MAINTENANCE_DEFERRED',
        reason: `known maintenance active (${obs.maintenance.kind}) - judgment deferred; stale heartbeat is expected, not evidence of a freeze`,
      };
    }
    // Maintenance overstayed its deferral budget: fail closed toward escalation, not permanent
    // blindness. Fall through to the normal path below.
  }

  // Startup grace: a stale heartbeat with a live PID right after boot is boot, not a freeze.
  const engineAgeMs = obs.engineStartedAtMs != null ? nowMs - obs.engineStartedAtMs : null;
  if (obs.pidAlive && engineAgeMs !== null && engineAgeMs >= 0 && engineAgeMs < cfg.startupGraceMs) {
    return {
      machine: { ...machine, state: 'STARTUP_GRACE', maintenanceActiveSinceMs: null },
      action: 'STARTUP_GRACE',
      reason: `engine started ${Math.round(engineAgeMs / 1000)}s ago (within ${Math.round(cfg.startupGraceMs / 1000)}s startup grace) - stale heartbeat is boot, not a freeze`,
    };
  }

  const consecutiveBadTicks = machine.consecutiveBadTicks + 1;

  if (consecutiveBadTicks < cfg.confirmTicks) {
    return {
      machine: { ...machine, state: 'SUSPECT', consecutiveBadTicks, maintenanceActiveSinceMs: null },
      action: 'LOG_SUSPECT',
      reason: `bad tick ${consecutiveBadTicks}/${cfg.confirmTicks} to confirm - no action yet`,
    };
  }

  // Confirmed bad for cfg.confirmTicks in a row. A live-but-unresponsive ("frozen") process is
  // not treated the same as a genuinely dead one - it demands a much longer confirmation window
  // (frozenConfirmTicks) before this escalates to a force-kill, specifically to rule out "merely
  // slow" (a busy AI call, a burst of logging, a GC pause) rather than truly stuck. See
  // WatchdogConfig's own doc comment for why a bounded force-kill here is acceptable at all.
  if (obs.pidAlive) {
    if (consecutiveBadTicks < cfg.frozenConfirmTicks) {
      return {
        machine: { ...machine, state: 'SUSPECT', consecutiveBadTicks, maintenanceActiveSinceMs: null },
        action: 'LOG_SUSPECT',
        reason: `frozen-suspect tick ${consecutiveBadTicks}/${cfg.frozenConfirmTicks} - pid alive, longer confirmation required before force-kill`,
      };
    }
    return gatedRestart(machine, cfg, nowMs, consecutiveBadTicks, 'FORCE_KILL_AND_RESTART', 'FROZEN_CONFIRMED');
  }

  // PID confirmed gone. Was this an operator-requested stop, or a genuine unexpected death?
  if (obs.cleanShutdown === true) {
    return {
      machine: { ...machine, state: 'STOPPED_INTENTIONALLY', consecutiveBadTicks, maintenanceActiveSinceMs: null },
      action: 'NONE',
      reason: 'pid gone and cleanShutdown=true - intentional stop, no restart',
    };
  }

  // Genuine unexpected death (cleanShutdown false, or the session file itself is unreadable -
  // fail toward "treat as unexpected," since a missing/corrupt marker is not evidence of an
  // intentional stop).
  return gatedRestart(machine, cfg, nowMs, consecutiveBadTicks, 'RESTART', 'RESTARTING');
}

/**
 * Shared gate for every restart action (dead-process restart and frozen force-kill alike):
 * storm-lockout budget first, then exponential-backoff cooldown. Both are equally disruptive
 * recovery actions and count against the same budget.
 */
function gatedRestart(
  machine: StateMachine,
  cfg: WatchdogConfig,
  nowMs: number,
  consecutiveBadTicks: number,
  action: 'RESTART' | 'FORCE_KILL_AND_RESTART',
  restartState: 'RESTARTING' | 'FROZEN_CONFIRMED',
): NextStateResult {
  const recentRestarts = pruneOldRestarts(machine.restartTimestamps, nowMs, cfg.restartWindowMs);

  if (recentRestarts.length >= cfg.maxRestarts) {
    const reason =
      `STORM LOCKOUT: ${recentRestarts.length} restarts within ${Math.round(cfg.restartWindowMs / 60000)}min ` +
      `(max ${cfg.maxRestarts}) - auto-restart halted, engine left in its last state; ` +
      'requires explicit operator action (`argus watchdog-clear-lockout`) after investigation';
    return {
      machine: {
        ...machine,
        state: 'STORM_LOCKOUT',
        consecutiveBadTicks,
        restartTimestamps: recentRestarts,
        maintenanceActiveSinceMs: null,
        lockoutReason: reason,
      },
      action: 'STORM_LOCKOUT',
      reason,
    };
  }

  const lastRestartAtMs =
    machine.lastRestartAtMs ?? (recentRestarts.length > 0 ? recentRestarts[recentRestarts.length - 1] : null);
  const requiredDelayMs = restartCooldownDelayMs(recentRestarts.length, cfg);
  if (lastRestartAtMs !== null && nowMs - lastRestartAtMs < requiredDelayMs) {
    const waitMs = Math.ceil((requiredDelayMs - (nowMs - lastRestartAtMs)) / 1000);
    const reason =
      `restart cooldown: ${recentRestarts.length} restart(s) in window, ` +
      `backoff requires ${Math.round(requiredDelayMs / 1000)}s between restarts - waiting ~${waitMs}s more`;
    return {
      machine: {
        ...machine,
        state: 'COOLDOWN_WAIT',
        consecutiveBadTicks,
        restartTimestamps: recentRestarts,
        maintenanceActiveSinceMs: null,
      },
      action: 'COOLDOWN_WAIT',
      reason,
    };
  }

  return {
    machine: {
      ...machine,
      state: restartState,
      consecutiveBadTicks,
      restartTimestamps: [...recentRestarts, nowMs],
      lastRestartAtMs: nowMs,
      maintenanceActiveSinceMs: null,
    },
    action,
    reason:
      action === 'FORCE_KILL_AND_RESTART'
        ? `frozen confirmed (${consecutiveBadTicks} consecutive bad ticks, pid alive) - force-kill then restart (budget/cooldown clear)`
        : `unexpected death confirmed (${consecutiveBadTicks} consecutive bad ticks, pid gone, cleanShutdown!=true) - restarting (budget/cooldown clear)`,
  };
}
