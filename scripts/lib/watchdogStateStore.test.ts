/**
 * Tests for the durable watchdog state store (defect #3): restart history and storm lockout
 * must survive watchdog restarts - the pre-existing budget lived only in process memory, so
 * restarting the watchdog silently reset it and the storm had no durable stop.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadWatchdogState,
  saveWatchdogState,
  clearStormLockout,
  defaultWatchdogPersistentState,
} from './watchdogStateStore';

describe('watchdogStateStore', () => {
  let dir: string;
  let statePath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'argus-wdstate-'));
    statePath = join(dir, 'wd.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads fresh defaults when the file is missing', () => {
    const s = loadWatchdogState(statePath);
    expect(s.stormLockout).toBe(false);
    expect(s.restartTimestamps).toEqual([]);
  });

  it('loads fresh defaults when the file is corrupt', () => {
    writeFileSync(statePath, '{corrupt');
    const s = loadWatchdogState(statePath);
    expect(s.stormLockout).toBe(false);
    expect(s.restartTimestamps).toEqual([]);
  });

  it('round-trips restart timestamps and a storm lockout (survives a watchdog "restart")', () => {
    const before = {
      ...defaultWatchdogPersistentState(),
      restartTimestamps: [1000, 2000, 3000],
      stormLockout: true,
      stormLockoutReason: '3 restarts within 60min (max 3) - STORM LOCKOUT',
      stormLockoutAt: new Date(4000).toISOString(),
    };
    expect(saveWatchdogState(before, statePath)).toBe(true);
    // A fresh watchdog process loading this file must see the same lockout.
    const after = loadWatchdogState(statePath);
    expect(after.stormLockout).toBe(true);
    expect(after.stormLockoutReason).toBe(before.stormLockoutReason);
    expect(after.restartTimestamps).toEqual([1000, 2000, 3000]);
  });

  it('clearStormLockout only clears the lockout - restart history is preserved for forensics', () => {
    const before = {
      ...defaultWatchdogPersistentState(),
      restartTimestamps: [1000, 2000, 3000],
      stormLockout: true,
      stormLockoutReason: 'test',
    };
    saveWatchdogState(before, statePath);
    expect(clearStormLockout(statePath)).toBe(true);
    const after = loadWatchdogState(statePath);
    expect(after.stormLockout).toBe(false);
    expect(after.stormLockoutReason).toBeUndefined();
    expect(after.restartTimestamps).toEqual([1000, 2000, 3000]);
  });

  it('clearStormLockout is a safe no-op when no lockout is active', () => {
    expect(clearStormLockout(statePath)).toBe(true);
    expect(loadWatchdogState(statePath).stormLockout).toBe(false);
  });
});
