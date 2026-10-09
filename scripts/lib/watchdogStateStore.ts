/**
 * Durable watchdog state: restart timestamps + storm lockout, persisted to
 * data/.argus_watchdog_state.json (override: ARGUS_WATCHDOG_STATE_PATH).
 *
 * 2026-10-08 defect #3 hardening: the pre-existing restart budget (maxRestarts per window) lived
 * only in the watchdog process's memory. Restarting the watchdog process itself - which an
 * operator does routinely - silently reset the budget, so a restart storm had no durable stop:
 * kill -> restart -> watchdog restarted -> budget forgotten -> kill again. Persisting the
 * restart timestamps AND the storm-lockout flag closes that exact gap: a fresh watchdog boot
 * with a still-active lockout re-enters STORM_LOCKOUT instead of restarting.
 *
 * Lifting the lockout is an explicit operator action (`argus watchdog-clear-lockout`), never an
 * automatic one: nothing in the watchdog's own tick path clears stormLockout.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface WatchdogPersistentState {
  schemaVersion: 1;
  /** ms-epoch timestamps of restarts this watchdog has performed, most recent last. */
  restartTimestamps: number[];
  /** True once a storm lockout engaged; only `argus watchdog-clear-lockout` may reset it. */
  stormLockout: boolean;
  stormLockoutReason?: string;
  stormLockoutAt?: string;
  updatedAt: string;
}

const DEFAULT_STATE_PATH = join(process.cwd(), 'data', '.argus_watchdog_state.json');

export function resolveWatchdogStatePath(): string {
  const override = process.env.ARGUS_WATCHDOG_STATE_PATH?.trim();
  return override || DEFAULT_STATE_PATH;
}

export function defaultWatchdogPersistentState(): WatchdogPersistentState {
  return {
    schemaVersion: 1,
    restartTimestamps: [],
    stormLockout: false,
    updatedAt: new Date().toISOString(),
  };
}

/** Loads persisted state. Missing or corrupt file -> fresh defaults (a corrupt store must not
 *  wedge the watchdog; losing the budget history fails closed toward MORE restarts only in the
 *  sense that an already-engaged lockout cannot be proven - which is why the CLI's clear path
 *  is explicit and logged, never silent). Never throws. */
export function loadWatchdogState(filePath: string = resolveWatchdogStatePath()): WatchdogPersistentState {
  try {
    if (!existsSync(filePath)) return defaultWatchdogPersistentState();
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<WatchdogPersistentState>;
    if (!raw || typeof raw !== 'object' || raw.schemaVersion !== 1) return defaultWatchdogPersistentState();
    return {
      schemaVersion: 1,
      restartTimestamps: Array.isArray(raw.restartTimestamps)
        ? raw.restartTimestamps.filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
        : [],
      stormLockout: raw.stormLockout === true,
      stormLockoutReason: typeof raw.stormLockoutReason === 'string' ? raw.stormLockoutReason : undefined,
      stormLockoutAt: typeof raw.stormLockoutAt === 'string' ? raw.stormLockoutAt : undefined,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    };
  } catch {
    return defaultWatchdogPersistentState();
  }
}

/** Atomic publish (tmp + rename) so a crash mid-write leaves the old complete state, not
 *  truncated JSON. Best-effort: returns false on failure rather than throwing. */
export function saveWatchdogState(
  state: WatchdogPersistentState,
  filePath: string = resolveWatchdogStatePath(),
): boolean {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const payload: WatchdogPersistentState = { ...state, updatedAt: new Date().toISOString() };
    const temporary = `${filePath}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(payload, null, 2), 'utf8');
      renameSync(temporary, filePath);
    } finally {
      try { unlinkSync(temporary); } catch { /* renamed or absent */ }
    }
    return true;
  } catch {
    return false;
  }
}

/** Explicit operator-only reset of a storm lockout. Called by `argus watchdog-clear-lockout`. */
export function clearStormLockout(filePath: string = resolveWatchdogStatePath()): boolean {
  const state = loadWatchdogState(filePath);
  state.stormLockout = false;
  state.stormLockoutReason = undefined;
  state.stormLockoutAt = undefined;
  return saveWatchdogState(state, filePath);
}
