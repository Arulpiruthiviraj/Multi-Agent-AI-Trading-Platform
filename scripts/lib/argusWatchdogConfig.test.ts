import { describe, it, expect } from 'vitest';
import watchdogJson from '../../config/watchdog.json';
import {
  loadWatchdogConfig,
  REQUIRED_WATCHDOG_KEYS,
  DEFAULT_WATCHDOG_CONFIG,
} from './argusWatchdogLogic';

/**
 * I-W3 regression: config/watchdog.json's own $comment documents "Missing keys fail watchdog
 * startup - a watchdog with unknown thresholds must not guess", but the loader used to fall
 * back to silent hardcoded defaults for any missing key. These tests pin the documented
 * contract: incomplete/invalid config fails loudly instead of guarding with guessed
 * thresholds. Also pins that the dead `pollMs` JSON key is gone - the poll loop reads
 * ARGUS_WATCHDOG_POLL_MS (env) only.
 */
describe('watchdog config loading contract (I-W3)', () => {
  it('loads the shipped config completely - every required key present and positive', () => {
    const cfg = loadWatchdogConfig();
    for (const key of REQUIRED_WATCHDOG_KEYS) {
      expect(cfg[key]).toBe((watchdogJson as Record<string, unknown>)[key]);
    }
    expect(DEFAULT_WATCHDOG_CONFIG).toEqual(cfg);
  });

  it('fails loudly on a missing key instead of silently defaulting', () => {
    const raw = { ...(watchdogJson as Record<string, unknown>) };
    delete raw.heartbeatStaleMs;
    expect(() => loadWatchdogConfig(raw)).toThrow(/missing or invalid.*heartbeatStaleMs/);
  });

  it('fails loudly on invalid values (zero, negative, NaN, string, null)', () => {
    for (const bad of [0, -1, Number.NaN, '60000', null]) {
      const raw = { ...(watchdogJson as Record<string, unknown>), confirmTicks: bad };
      expect(() => loadWatchdogConfig(raw)).toThrow(/confirmTicks/);
    }
  });

  it('pollMs is gone from the shipped JSON - the poll loop reads ARGUS_WATCHDOG_POLL_MS env only', () => {
    expect(Object.keys(watchdogJson)).not.toContain('pollMs');
  });
});
