import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { buildSessionConfigManifest, assertSessionEffectiveConfiguration, requiredFlagNamesFromConfig } from './sessionEnvGuard';

const REQUIRED = requiredFlagNamesFromConfig(path.resolve(__dirname, '..', '..'));
const good = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  SYNTHETIC_SIMULATION: 'true', PAPER_TRADING_ONLY: 'true', ...Object.fromEntries(REQUIRED.map((k) => [k, 'true'])), ...extra,
});

describe('sessionEnvGuard (REGRESSION 2026-10-14: a worktree without production flags produced a false unprotected-position oracle verdict)', () => {
  it('reads the required behavior flag names from the reviewed config, not from literals', () => {
    expect(REQUIRED.length).toBeGreaterThan(0);
  });
  it('refuses a session whose RESOLVED config lacks a required production-equivalent flag (the exact seed-33 failure)', () => {
    const env = good(); delete env[REQUIRED[0]];
    expect(() => assertSessionEffectiveConfiguration(env, REQUIRED)).toThrow(/required production-equivalent flag/);
  });
  it('refuses broker/provider credentials in a synthetic session (isolation) and a non-paper or non-synthetic environment', () => {
    expect(() => assertSessionEffectiveConfiguration(good({ ALPACA_API_KEY: 'x' }), REQUIRED)).toThrow(/isolation breach/);
    expect(() => assertSessionEffectiveConfiguration(good({ PAPER_TRADING_ONLY: 'false' }), REQUIRED)).toThrow(/PAPER_TRADING_ONLY/);
    expect(() => assertSessionEffectiveConfiguration(good({ SYNTHETIC_SIMULATION: 'false' }), REQUIRED)).toThrow(/SYNTHETIC_SIMULATION/);
  });
  it('accepts a good config, and the manifest never contains a credential value', () => {
    const m = assertSessionEffectiveConfiguration(good(), REQUIRED);
    expect(m.problems).toEqual([]);
    const withSecret = buildSessionConfigManifest(good({ ALPACA_API_KEY: 'SUPER-SECRET-VALUE' }), REQUIRED);
    expect(JSON.stringify(withSecret)).not.toContain('SUPER-SECRET-VALUE');
    expect(withSecret.credentialsPresent.ALPACA_API_KEY).toBe(true);
  });
  it('an explicit labeled deviation is the only way to run a non-certifiable config', () => {
    const env = good({ ARGUS_SYNTH_ALLOW_CONFIG_DEVIATION: '1' }); delete env[REQUIRED[0]];
    expect(() => assertSessionEffectiveConfiguration(env, REQUIRED)).not.toThrow();
  });
});
