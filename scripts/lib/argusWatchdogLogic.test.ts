import { describe, it, expect } from 'vitest';
import {
  initialStateMachine,
  nextState,
  DEFAULT_WATCHDOG_CONFIG,
  type TickObservation,
  type StateMachine,
} from './argusWatchdogLogic';

const HEALTHY_OBS: TickObservation = {
  pidAlive: true,
  healthOk: true,
  heartbeatAgeMs: 5_000,
  cleanShutdown: false,
};

const DEAD_OBS_UNEXPECTED: TickObservation = {
  pidAlive: false,
  healthOk: false,
  heartbeatAgeMs: 120_000,
  cleanShutdown: false,
};

const DEAD_OBS_INTENTIONAL: TickObservation = {
  pidAlive: false,
  healthOk: false,
  heartbeatAgeMs: 120_000,
  cleanShutdown: true,
};

const FROZEN_OBS: TickObservation = {
  // pid still alive, but health endpoint stopped answering and heartbeat file stopped advancing
  pidAlive: true,
  healthOk: false,
  heartbeatAgeMs: 120_000,
  cleanShutdown: false,
};

describe('argusWatchdogLogic', () => {
  it('stays HEALTHY on consecutive healthy ticks', () => {
    let m = initialStateMachine();
    for (let i = 0; i < 5; i++) {
      const r = nextState(m, HEALTHY_OBS, DEFAULT_WATCHDOG_CONFIG, i * 1000);
      m = r.machine;
      expect(r.action).toBe('NONE');
      expect(m.state).toBe('HEALTHY');
    }
  });

  it('does not act on a single bad tick - requires confirmTicks in a row (avoids false positives on a transient blip)', () => {
    const m0 = initialStateMachine();
    const r1 = nextState(m0, DEAD_OBS_UNEXPECTED, DEFAULT_WATCHDOG_CONFIG, 1000);
    expect(r1.action).toBe('LOG_SUSPECT');
    expect(r1.machine.state).toBe('SUSPECT');

    // Recovers on the next tick before confirmTicks is reached.
    const r2 = nextState(r1.machine, HEALTHY_OBS, DEFAULT_WATCHDOG_CONFIG, 2000);
    expect(r2.action).toBe('RESUMED_HEALTHY');
    expect(r2.machine.state).toBe('HEALTHY');
    expect(r2.machine.consecutiveBadTicks).toBe(0);
  });

  it('restarts only after confirmTicks consecutive bad ticks with pid genuinely gone and cleanShutdown=false', () => {
    let m = initialStateMachine();
    let lastAction: string = 'NONE';
    for (let i = 0; i < DEFAULT_WATCHDOG_CONFIG.confirmTicks; i++) {
      const r = nextState(m, DEAD_OBS_UNEXPECTED, DEFAULT_WATCHDOG_CONFIG, i * 1000);
      m = r.machine;
      lastAction = r.action;
    }
    expect(lastAction).toBe('RESTART');
    expect(m.state).toBe('RESTARTING');
    expect(m.restartTimestamps.length).toBe(1);
  });

  it('never restarts when cleanShutdown=true - treats it as an intentional stop', () => {
    let m = initialStateMachine();
    let lastAction: string = 'NONE';
    for (let i = 0; i < DEFAULT_WATCHDOG_CONFIG.confirmTicks; i++) {
      const r = nextState(m, DEAD_OBS_INTENTIONAL, DEFAULT_WATCHDOG_CONFIG, i * 1000);
      m = r.machine;
      lastAction = r.action;
    }
    expect(lastAction).toBe('NONE');
    expect(m.state).toBe('STOPPED_INTENTIONALLY');
  });

  it('does NOT force-kill a frozen-but-alive process before frozenConfirmTicks - only flags it while below that threshold', () => {
    let m = initialStateMachine();
    let lastAction: string = 'NONE';
    // One tick short of frozenConfirmTicks - must still be a flag, not an action.
    for (let i = 0; i < DEFAULT_WATCHDOG_CONFIG.frozenConfirmTicks - 1; i++) {
      const r = nextState(m, FROZEN_OBS, DEFAULT_WATCHDOG_CONFIG, i * 1000);
      m = r.machine;
      lastAction = r.action;
    }
    expect(lastAction).toBe('LOG_SUSPECT');
    expect(m.state).toBe('SUSPECT');
  });

  it('force-kills a frozen-but-alive process once frozenConfirmTicks is reached, and it counts against the restart budget', () => {
    let m = initialStateMachine();
    let lastAction: string = 'NONE';
    for (let i = 0; i < DEFAULT_WATCHDOG_CONFIG.frozenConfirmTicks; i++) {
      const r = nextState(m, FROZEN_OBS, DEFAULT_WATCHDOG_CONFIG, i * 1000);
      m = r.machine;
      lastAction = r.action;
    }
    expect(lastAction).toBe('FORCE_KILL_AND_RESTART');
    expect(m.state).toBe('FROZEN_CONFIRMED');
    expect(m.restartTimestamps.length).toBe(1);
  });

  it('halts with ALERT_HALTED instead of force-killing a frozen process once the restart budget is already exhausted', () => {
    const cfg = { ...DEFAULT_WATCHDOG_CONFIG, maxRestarts: 0, frozenConfirmTicks: 2 };
    let m = initialStateMachine();
    let lastAction: string = 'NONE';
    for (let i = 0; i < cfg.frozenConfirmTicks; i++) {
      const r = nextState(m, FROZEN_OBS, cfg, i * 1000);
      m = r.machine;
      lastAction = r.action;
    }
    expect(lastAction).toBe('ALERT_HALTED');
    expect(m.state).toBe('RESTART_BUDGET_EXHAUSTED');
  });

  it('enforces a bounded restart budget and halts with ALERT_HALTED instead of storm-restarting', () => {
    const cfg = { ...DEFAULT_WATCHDOG_CONFIG, maxRestarts: 2, confirmTicks: 1 };
    let m: StateMachine = initialStateMachine();
    let nowMs = 0;
    const actions: string[] = [];

    // Restart 1
    let r = nextState(m, DEAD_OBS_UNEXPECTED, cfg, (nowMs += 1000));
    m = r.machine; actions.push(r.action);
    // Pretend it came back healthy briefly, then died again (simulates a real recurring failure).
    r = nextState(m, HEALTHY_OBS, cfg, (nowMs += 1000));
    m = r.machine; actions.push(r.action);

    // Restart 2
    r = nextState(m, DEAD_OBS_UNEXPECTED, cfg, (nowMs += 1000));
    m = r.machine; actions.push(r.action);
    r = nextState(m, HEALTHY_OBS, cfg, (nowMs += 1000));
    m = r.machine; actions.push(r.action);

    // Third death within the restart window should now be refused and alert instead.
    r = nextState(m, DEAD_OBS_UNEXPECTED, cfg, (nowMs += 1000));
    m = r.machine; actions.push(r.action);

    expect(actions.filter((a) => a === 'RESTART').length).toBe(2);
    expect(actions[actions.length - 1]).toBe('ALERT_HALTED');
    expect(m.state).toBe('RESTART_BUDGET_EXHAUSTED');
  });

  it('prunes restarts outside the rolling window, allowing new restarts again later', () => {
    const cfg = { ...DEFAULT_WATCHDOG_CONFIG, maxRestarts: 1, confirmTicks: 1, restartWindowMs: 10_000 };
    let m: StateMachine = initialStateMachine();

    let r = nextState(m, DEAD_OBS_UNEXPECTED, cfg, 0);
    m = r.machine;
    expect(r.action).toBe('RESTART');

    r = nextState(m, HEALTHY_OBS, cfg, 1_000);
    m = r.machine;

    // Second death still inside the 10s window - budget exhausted.
    r = nextState(m, DEAD_OBS_UNEXPECTED, cfg, 2_000);
    m = r.machine;
    expect(r.action).toBe('ALERT_HALTED');

    // Third death well outside the window - the first restart has aged out, budget available again.
    r = nextState(m, DEAD_OBS_UNEXPECTED, cfg, 50_000);
    expect(r.action).toBe('RESTART');
  });

  it('treats a missing/unreadable session file (cleanShutdown null) as unexpected, not intentional', () => {
    const obsUnreadable: TickObservation = { ...DEAD_OBS_UNEXPECTED, cleanShutdown: null };
    let m = initialStateMachine();
    let lastAction: string = 'NONE';
    for (let i = 0; i < DEFAULT_WATCHDOG_CONFIG.confirmTicks; i++) {
      const r = nextState(m, obsUnreadable, DEFAULT_WATCHDOG_CONFIG, i * 1000);
      m = r.machine;
      lastAction = r.action;
    }
    expect(lastAction).toBe('RESTART');
  });
});
