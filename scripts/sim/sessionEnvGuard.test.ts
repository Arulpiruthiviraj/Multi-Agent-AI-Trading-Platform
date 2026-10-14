import { describe, it, expect } from 'vitest';
import { assertProductionEnvPresentForSession } from './sessionEnvGuard';

describe('sessionEnvGuard (REGRESSION 2026-10-14: .env-less worktree produced a false "unprotected position" oracle verdict)', () => {
  it('refuses to run a certification session when the worktree has no .env', () => {
    expect(() => assertProductionEnvPresentForSession('/w', {}, () => false)).toThrow(/no \.env/);
  });
  it('passes when .env exists, or when the flag-off run is explicitly acknowledged', () => {
    expect(() => assertProductionEnvPresentForSession('/w', {}, () => true)).not.toThrow();
    expect(() => assertProductionEnvPresentForSession('/w', { ARGUS_SYNTH_ALLOW_MISSING_PROD_ENV: '1' }, () => false)).not.toThrow();
  });
});
