/**
 * Pure decision logic for the external Argus liveness watchdog (scripts/argusWatchdog.ts).
 *
 * Deliberately separated from all I/O (fs/http/child_process) so the state machine itself is
 * unit-testable without a real engine process. This process is NOT the trading engine and must
 * never import anything from src/server - it only reads the same plain files/HTTP endpoint an
 * operator would check by hand (data/.argus_engine.pid, data/.argus_runtime_session.json,
 * GET /api/v2/runtime/health) and, on confirmed death, shells out to the already-safe
 * `argus-cli start` - it never opens data/argus.db and never calls a trading/resume endpoint.
 *
 * Safety invariant this whole file exists to protect: this watchdog can restart a DEAD process,
 * but restarting is not the same as resuming trading. `argus-cli start`/`restart` already,
 * independently, always leaves tradingState at TRADING_PAUSED after any restart (verified live,
 * 2026-09-07 readiness audits) - this module has no code path that could bypass that, because it
 * never calls anything but the start command.
 */

export type WatchdogState =
  | 'HEALTHY'
  | 'SUSPECT'
  | 'CONFIRMED_DEAD'
  | 'FROZEN_CONFIRMED'
  | 'RESTARTING'
  | 'STARTED'
  | 'STOPPED_INTENTIONALLY'
  | 'RESTART_BUDGET_EXHAUSTED';

export interface TickObservation {
  /** Does the OS report this PID as alive right now (enginePid.ts's isPidAlive)? */
  pidAlive: boolean;
  /** Did GET /api/v2/runtime/health respond with HTTP ok this tick? */
  healthOk: boolean;
  /** Milliseconds since the session file's lastHeartbeatAt, or null if the file is unreadable. */
  heartbeatAgeMs: number | null;
  /** The session file's own cleanShutdown flag, or null if unreadable/missing. */
  cleanShutdown: boolean | null;
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
  /** Max restarts allowed inside restartWindowMs before halting auto-restart. Counts both a
   *  confirmed-dead restart and a forced frozen-process kill+restart against the same budget -
   *  both are equally disruptive recovery actions. */
  maxRestarts: number;
  restartWindowMs: number;
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  heartbeatStaleMs: 60_000,
  confirmTicks: 2,
  frozenConfirmTicks: 10,
  maxRestarts: 3,
  restartWindowMs: 60 * 60_000,
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
}

export function initialStateMachine(): StateMachine {
  return { state: 'HEALTHY', consecutiveBadTicks: 0, restartTimestamps: [] };
}

function pruneOldRestarts(timestamps: number[], nowMs: number, windowMs: number): number[] {
  return timestamps.filter((t) => nowMs - t <= windowMs);
}

/**
 * Advance the state machine by one tick. Never mutates its input; returns the next state plus an
 * explicit `action` the caller (the real I/O loop) should take. This function makes no I/O calls
 * itself - it is pure and deterministic given its inputs, which is what makes it unit-testable
 * without a real process.
 */
export function nextState(
  machine: StateMachine,
  obs: TickObservation,
  cfg: WatchdogConfig,
  nowMs: number,
): { machine: StateMachine; action: 'NONE' | 'LOG_SUSPECT' | 'RESTART' | 'FORCE_KILL_AND_RESTART' | 'ALERT_HALTED' | 'RESUMED_HEALTHY' } {
  const bad = isBadTick(obs, cfg);

  if (!bad) {
    if (machine.state !== 'HEALTHY') {
      return {
        machine: { ...machine, state: 'HEALTHY', consecutiveBadTicks: 0 },
        action: 'RESUMED_HEALTHY',
      };
    }
    return { machine: { ...machine, consecutiveBadTicks: 0 }, action: 'NONE' };
  }

  const consecutiveBadTicks = machine.consecutiveBadTicks + 1;

  if (consecutiveBadTicks < cfg.confirmTicks) {
    return {
      machine: { ...machine, state: 'SUSPECT', consecutiveBadTicks },
      action: 'LOG_SUSPECT',
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
        machine: { ...machine, state: 'SUSPECT', consecutiveBadTicks },
        action: 'LOG_SUSPECT',
      };
    }
    const recentRestarts = pruneOldRestarts(machine.restartTimestamps, nowMs, cfg.restartWindowMs);
    if (recentRestarts.length >= cfg.maxRestarts) {
      return {
        machine: { ...machine, state: 'RESTART_BUDGET_EXHAUSTED', consecutiveBadTicks, restartTimestamps: recentRestarts },
        action: 'ALERT_HALTED',
      };
    }
    return {
      machine: {
        ...machine,
        state: 'FROZEN_CONFIRMED',
        consecutiveBadTicks,
        restartTimestamps: [...recentRestarts, nowMs],
      },
      action: 'FORCE_KILL_AND_RESTART',
    };
  }

  // PID confirmed gone. Was this an operator-requested stop, or a genuine unexpected death?
  if (obs.cleanShutdown === true) {
    return {
      machine: { ...machine, state: 'STOPPED_INTENTIONALLY', consecutiveBadTicks },
      action: 'NONE',
    };
  }

  // Genuine unexpected death (cleanShutdown false, or the session file itself is unreadable -
  // fail toward "treat as unexpected," since a missing/corrupt marker is not evidence of an
  // intentional stop).
  const recentRestarts = pruneOldRestarts(machine.restartTimestamps, nowMs, cfg.restartWindowMs);
  if (recentRestarts.length >= cfg.maxRestarts) {
    return {
      machine: { ...machine, state: 'RESTART_BUDGET_EXHAUSTED', consecutiveBadTicks, restartTimestamps: recentRestarts },
      action: 'ALERT_HALTED',
    };
  }

  return {
    machine: {
      ...machine,
      state: 'RESTARTING',
      consecutiveBadTicks,
      restartTimestamps: [...recentRestarts, nowMs],
    },
    action: 'RESTART',
  };
}
