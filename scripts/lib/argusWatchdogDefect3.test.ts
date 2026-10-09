
/**
 * Defect #3 hardening tests (2026-10-08): the watchdog falsely declared the engine frozen
 * during known event-loop-blocking maintenance (DB backup, heap snapshot, graceful drain) and
 * created a kill -> restart -> re-maintenance -> kill restart storm.
 */
import { describe, it, expect } from 'vitest';
import {
  initialStateMachine,
  nextState,
  seedStateMachineFromPersistence,
  restartCooldownDelayMs,
  DEFAULT_WATCHDOG_CONFIG,
  type TickObservation,
  type StateMachine,
  type WatchdogAction,
} from './argusWatchdogLogic';

const HEALTHY_OBS: TickObservation = {
  pidAlive: true,
  healthOk: true,
  heartbeatAgeMs: 5_000,
  cleanShutdown: false,
};

const FROZEN_OBS: TickObservation = {
  // pid still alive, but health endpoint stopped answering and heartbeat file stopped advancing
  pidAlive: true,
  healthOk: false,
  heartbeatAgeMs: 120_000,
  cleanShutdown: false,
};

const DEAD_OBS_UNEXPECTED: TickObservation = {
  pidAlive: false,
  healthOk: false,
  heartbeatAgeMs: 120_000,
  cleanShutdown: false,
};

const FROZEN_DURING_BACKUP: TickObservation = {
  ...FROZEN_OBS,
  maintenance: { active: true, kind: 'backup:RUNNING' },
};

function driveTicks(m: StateMachine, obs: TickObservation, cfg: typeof DEFAULT_WATCHDOG_CONFIG, ticks: number, tickMs = 1000): { machine: StateMachine; actions: WatchdogAction[] } {
  const actions: WatchdogAction[] = [];
  let nowMs = 0;
  for (let i = 0; i < ticks; i++) {
    nowMs += tickMs;
    const r = nextState(m, obs, cfg, nowMs);
    m = r.machine;
    actions.push(r.action);
  }
  return { machine: m, actions };
}

describe('defect #3 (a): maintenance deferral - stale heartbeat during known maintenance is not a freeze', () => {
  it('defers judgment (never restarts, never force-kills) while a fresh backup:RUNNING signal is active', () => {
    let m = initialStateMachine();
    // Far more ticks than frozenConfirmTicks - without deferral this would force-kill.
    const { machine, actions } = driveTicks(m, FROZEN_DURING_BACKUP, DEFAULT_WATCHDOG_CONFIG, DEFAULT_WATCHDOG_CONFIG.frozenConfirmTicks * 3);
    expect(actions.every((a) => a === 'MAINTENANCE_DEFERRED')).toBe(true);
    expect(actions).not.toContain('RESTART');
    expect(actions).not.toContain('FORCE_KILL_AND_RESTART');
    expect(actions).not.toContain('STORM_LOCKOUT');
    expect(machine.state).toBe('MAINTENANCE_DEFERRED');
    // Escalation counters freeze during deferral - never incremented toward the kill threshold.
    expect(machine.consecutiveBadTicks).toBe(0);
    expect(machine.restartTimestamps).toHaveLength(0);
  });

  it('also defers for shutdown-in-progress and startup signals', () => {
    const shutdownObs: TickObservation = { ...FROZEN_OBS, maintenance: { active: true, kind: 'shutdown' } };
    const startupObs: TickObservation = { ...FROZEN_OBS, maintenance: { active: true, kind: 'startup' } };
    for (const obs of [shutdownObs, startupObs]) {
      const { machine, actions } = driveTicks(initialStateMachine(), obs, DEFAULT_WATCHDOG_CONFIG, DEFAULT_WATCHDOG_CONFIG.frozenConfirmTicks + 2);
      expect(actions.every((a) => a === 'MAINTENANCE_DEFERRED')).toBe(true);
      expect(machine.restartTimestamps).toHaveLength(0);
    }
  });

  it('resumes normal escalation once maintenance ends - a genuinely stuck process still gets caught', () => {
    let m = initialStateMachine();
    // Maintenance active for a while, then the signal goes away while the process stays frozen.
    let r = driveTicks(m, FROZEN_DURING_BACKUP, DEFAULT_WATCHDOG_CONFIG, 5);
    m = r.machine;
    expect(m.state).toBe('MAINTENANCE_DEFERRED');
    // Maintenance over, still frozen: escalation now proceeds from frozen counters (which were
    // frozen at 0 during deferral, so the full confirmation window still applies - fail closed).
    const cfg = { ...DEFAULT_WATCHDOG_CONFIG, restartCooldownBaseMs: 1 };
    const after = driveTicks(m, FROZEN_OBS, cfg, DEFAULT_WATCHDOG_CONFIG.frozenConfirmTicks);
    expect(after.actions[after.actions.length - 1]).toBe('FORCE_KILL_AND_RESTART');
  });

  it('ignores maintenance signals older than the freshness window (untrusted publisher)', () => {
    // A maintenance claim is only trusted while fresh; the I/O layer nulls stale signals, so
    // here we simulate exactly that: maintenance: null -> normal escalation applies.
    const staleSignalObs: TickObservation = { ...FROZEN_OBS, maintenance: null };
    const { actions } = driveTicks(initialStateMachine(), staleSignalObs, DEFAULT_WATCHDOG_CONFIG, DEFAULT_WATCHDOG_CONFIG.frozenConfirmTicks);
    expect(actions[actions.length - 1]).toBe('FORCE_KILL_AND_RESTART');
  });

  it('bounds deferral: maintenance that wedges past maintenanceDeferralMaxMs resumes escalation', () => {
    const cfg = { ...DEFAULT_WATCHDOG_CONFIG, maintenanceDeferralMaxMs: 5_000, restartCooldownBaseMs: 1 };
    let m = initialStateMachine();
    // 5 ticks of 1s each stay inside the 5s deferral budget...
    let r = driveTicks(m, FROZEN_DURING_BACKUP, cfg, 5);
    m = r.machine;
    expect(r.actions.every((a) => a === 'MAINTENANCE_DEFERRED')).toBe(true);
    // ...but one tick past the budget fails closed toward escalation: counters start moving.
    const oneMore = nextState(m, FROZEN_DURING_BACKUP, cfg, 6_001);
    expect(oneMore.action).not.toBe('MAINTENANCE_DEFERRED');
    expect(oneMore.machine.consecutiveBadTicks).toBe(1);
  });
});

describe('defect #3: startup grace - a fresh boot is not a freeze', () => {
  it('defers judgment while the engine is inside the startup grace window', () => {
    const cfg = { ...DEFAULT_WATCHDOG_CONFIG, startupGraceMs: 180_000 };
    const nowMs = 1_000_000_000;
    const bootObs: TickObservation = {
      ...FROZEN_OBS,
      engineStartedAtMs: nowMs - 60_000, // booted 60s ago - inside the 180s grace
    };
    const r = nextState(initialStateMachine(), bootObs, cfg, nowMs);
    expect(r.action).toBe('STARTUP_GRACE');
    expect(r.machine.state).toBe('STARTUP_GRACE');
    expect(r.machine.consecutiveBadTicks).toBe(0);
  });

  it('escalates normally once the startup grace window has passed', () => {
    const cfg = { ...DEFAULT_WATCHDOG_CONFIG, startupGraceMs: 180_000, restartCooldownBaseMs: 1 };
    const bootObs: TickObservation = {
      ...FROZEN_OBS,
      engineStartedAtMs: -300_000, // booted 300s before the tick clock's epoch - grace expired
    };
    let m = initialStateMachine();
    const { actions } = driveTicks(m, bootObs, cfg, DEFAULT_WATCHDOG_CONFIG.frozenConfirmTicks, 30_000);
    expect(actions[actions.length - 1]).toBe('FORCE_KILL_AND_RESTART');
  });
});

describe('defect #3 (b): restart discipline - cooldown with exponential backoff', () => {
  it('restartCooldownDelayMs doubles per restart in window and caps at the max', () => {
    const cfg = DEFAULT_WATCHDOG_CONFIG;
    expect(restartCooldownDelayMs(0, cfg)).toBe(cfg.restartCooldownBaseMs);
    expect(restartCooldownDelayMs(1, cfg)).toBe(cfg.restartCooldownBaseMs * 2);
    expect(restartCooldownDelayMs(2, cfg)).toBe(cfg.restartCooldownBaseMs * 4);
    // Cap holds for large counts (no overflow-driven surprise).
    expect(restartCooldownDelayMs(100, cfg)).toBe(cfg.restartCooldownMaxMs);
    expect(restartCooldownDelayMs(3, cfg)).toBeLessThanOrEqual(cfg.restartCooldownMaxMs);
  });

  it('N rapid stale readings produce at most the capped number of restarts with growing intervals', () => {
    const cfg = {
      ...DEFAULT_WATCHDOG_CONFIG,
      confirmTicks: 1,
      frozenConfirmTicks: 1,
      maxRestarts: 10,
      restartCooldownBaseMs: 60_000,
      restartCooldownMaxMs: 3_600_000,
    };
    let m = initialStateMachine();
    const restartAt: number[] = [];
    // Simulate a frozen process observed every second for 20 minutes.
    for (let t = 0; t < 20 * 60; t++) {
      const r = nextState(m, FROZEN_OBS, cfg, t * 1000);
      m = r.machine;
      if (r.action === 'FORCE_KILL_AND_RESTART') restartAt.push(t * 1000);
    }
    // Budget (10) is not the binding constraint here - backoff is: restart 2 needs 120s after
    // restart 1, restart 3 needs 240s after restart 2, etc. Intervals must strictly grow.
    expect(restartAt.length).toBeGreaterThanOrEqual(3);
    expect(restartAt.length).toBeLessThan(10);
    const gaps = restartAt.slice(1).map((t, i) => t - restartAt[i]);
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i]).toBeGreaterThan(gaps[i - 1]);
    }
    // First two gaps are exactly the configured backoff steps (120s, 240s).
    expect(gaps[0]).toBe(120_000);
    expect(gaps[1]).toBe(240_000);
  });

  it('a needed restart is delayed - not skipped - by the cooldown, then proceeds', () => {
    const cfg = {
      ...DEFAULT_WATCHDOG_CONFIG,
      confirmTicks: 1,
      frozenConfirmTicks: 1,
      maxRestarts: 5,
      restartCooldownBaseMs: 60_000,
    };
    let m = initialStateMachine();
    let r = nextState(m, FROZEN_OBS, cfg, 0);
    m = r.machine;
    expect(r.action).toBe('FORCE_KILL_AND_RESTART');
    // 30s later: still frozen, but inside the 120s backoff - wait, don't storm.
    r = nextState(m, FROZEN_OBS, cfg, 30_000);
    expect(r.action).toBe('COOLDOWN_WAIT');
    expect(r.machine.state).toBe('COOLDOWN_WAIT');
    m = r.machine;
    // Past the backoff: the restart proceeds.
    r = nextState(m, FROZEN_OBS, cfg, 121_000);
    expect(r.action).toBe('FORCE_KILL_AND_RESTART');
  });
});

describe('defect #3 (c): storm lockout engages and survives watchdog restarts', () => {
  it('seedStateMachineFromPersistence re-enters STORM_LOCKOUT from a persisted lockout', () => {
    const seeded = seedStateMachineFromPersistence({
      restartTimestamps: [1000, 2000, 3000],
      stormLockout: true,
      stormLockoutReason: 'test lockout',
    });
    expect(seeded.state).toBe('STORM_LOCKOUT');
    // Any further observation - healthy, dead, or frozen - produces no restart action.
    for (const obs of [HEALTHY_OBS, DEAD_OBS_UNEXPECTED, FROZEN_OBS]) {
      const r = nextState(seeded, obs, DEFAULT_WATCHDOG_CONFIG, 999_999);
      expect(r.action).toBe('NONE');
      expect(r.machine.state).toBe('STORM_LOCKOUT');
    }
  });

  it('seeded restart history (no lockout) still counts against the budget after a watchdog restart', () => {
    const cfg = { ...DEFAULT_WATCHDOG_CONFIG, maxRestarts: 3, confirmTicks: 1, restartCooldownBaseMs: 1, restartWindowMs: 3_600_000 };
    // Simulate a watchdog restart after 3 real restarts: the new process loads the timestamps.
    const seeded = seedStateMachineFromPersistence({
      restartTimestamps: [1_000_000, 1_001_000, 1_002_000],
      stormLockout: false,
    });
    const r = nextState(seeded, DEAD_OBS_UNEXPECTED, cfg, 1_003_000);
    expect(r.action).toBe('STORM_LOCKOUT');
    expect(r.machine.state).toBe('STORM_LOCKOUT');
  });
});
