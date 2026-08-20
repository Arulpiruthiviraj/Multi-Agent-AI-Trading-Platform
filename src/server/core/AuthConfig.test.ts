import { describe, it, expect, vi } from 'vitest';
import {
  isAuthEnabled,
  validateCredentials,
  isSessionValid,
  checkAuthConfig,
  enforceAuthConfigOrExit,
  DEFAULT_SESSION_SECRET,
  allowUnauthenticatedRequest,
} from './AuthConfig';

const REAL_ENV = {
  AUTH_USERNAME: 'admin',
  AUTH_PASSWORD: 'correct-horse-battery-staple',
  AUTH_SESSION_SECRET: 'a-real-generated-secret',
  NODE_ENV: 'development',
};

describe('AuthConfig - validateCredentials', () => {
  it('rejects login when AUTH_PASSWORD is missing, even with a matching empty/undefined body (the real bypass this fixes)', () => {
    const unconfigured = { AUTH_USERNAME: undefined, AUTH_PASSWORD: undefined };
    expect(validateCredentials(unconfigured, undefined, undefined)).toBe(false);
    expect(validateCredentials(unconfigured, '', '')).toBe(false);
  });

  it('rejects an incorrect password when auth is enabled', () => {
    expect(validateCredentials(REAL_ENV, 'admin', 'wrong-password')).toBe(false);
  });

  it('rejects an incorrect username when auth is enabled', () => {
    expect(validateCredentials(REAL_ENV, 'not-admin', REAL_ENV.AUTH_PASSWORD)).toBe(false);
  });

  it('accepts the correct username/password when auth is enabled', () => {
    expect(validateCredentials(REAL_ENV, 'admin', REAL_ENV.AUTH_PASSWORD)).toBe(true);
  });

  it('rejects non-string credentials (e.g. objects/arrays smuggled in a JSON body)', () => {
    expect(validateCredentials(REAL_ENV, { toString: () => 'admin' }, REAL_ENV.AUTH_PASSWORD)).toBe(false);
    expect(validateCredentials(REAL_ENV, 'admin', ['correct-horse-battery-staple'])).toBe(false);
  });

  it('rejects empty-string credentials even when auth is enabled', () => {
    expect(validateCredentials(REAL_ENV, '', '')).toBe(false);
  });
});

describe('AuthConfig - isAuthEnabled', () => {
  it('is disabled when AUTH_PASSWORD is unset', () => {
    expect(isAuthEnabled({})).toBe(false);
  });

  it('is enabled when AUTH_PASSWORD is set', () => {
    expect(isAuthEnabled({ AUTH_PASSWORD: 'x' })).toBe(true);
  });
});

describe('AuthConfig - isSessionValid (expired session/token)', () => {
  const now = 1_700_000_000_000;

  it('rejects a null/undefined session (no token presented)', () => {
    expect(isSessionValid(null, now)).toBe(false);
    expect(isSessionValid(undefined, now)).toBe(false);
  });

  it('rejects an expired session', () => {
    expect(isSessionValid({ expiresAt: now - 1000 }, now)).toBe(false);
  });

  it('accepts a session that has not yet expired', () => {
    expect(isSessionValid({ expiresAt: now + 1000 }, now)).toBe(true);
  });
});

describe('AuthConfig - checkAuthConfig (startup validation)', () => {
  it('flags production with no AUTH_PASSWORD as fatal', () => {
    const issues = checkAuthConfig({ NODE_ENV: 'production' });
    expect(issues.some(i => i.fatal)).toBe(true);
  });

  it('flags AUTH_PASSWORD set without AUTH_USERNAME as fatal', () => {
    const issues = checkAuthConfig({ AUTH_PASSWORD: 'x', AUTH_SESSION_SECRET: 'real-secret' });
    expect(issues.some(i => i.fatal && /AUTH_USERNAME/.test(i.message))).toBe(true);
  });

  it('flags AUTH_PASSWORD set with the default session secret as fatal', () => {
    const issues = checkAuthConfig({ AUTH_USERNAME: 'admin', AUTH_PASSWORD: 'x', AUTH_SESSION_SECRET: DEFAULT_SESSION_SECRET });
    expect(issues.some(i => i.fatal && /AUTH_SESSION_SECRET/.test(i.message))).toBe(true);
  });

  it('flags AUTH_PASSWORD set with no session secret at all as fatal', () => {
    const issues = checkAuthConfig({ AUTH_USERNAME: 'admin', AUTH_PASSWORD: 'x' });
    expect(issues.some(i => i.fatal && /AUTH_SESSION_SECRET/.test(i.message))).toBe(true);
  });

  it('is fully non-fatal for a correctly configured production environment', () => {
    const issues = checkAuthConfig({ ...REAL_ENV, NODE_ENV: 'production' });
    expect(issues.some(i => i.fatal)).toBe(false);
  });

  it('warns (non-fatal) but does not block development mode with no auth configured', () => {
    const issues = checkAuthConfig({ NODE_ENV: 'development' });
    expect(issues.some(i => i.fatal)).toBe(false);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('is fully clean (no issues at all) for a correctly configured dev environment with auth enabled', () => {
    const issues = checkAuthConfig(REAL_ENV);
    expect(issues.length).toBe(0);
  });
});

describe('AuthConfig - enforceAuthConfigOrExit', () => {
  it('exits the process on a fatal config issue and logs an error, without proceeding', () => {
    const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    const exit = vi.fn();
    enforceAuthConfigOrExit({ NODE_ENV: 'production' }, log, exit);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.error).toHaveBeenCalled();
  });

  it('does not exit and logs an info line for a correctly configured environment', () => {
    const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    const exit = vi.fn();
    enforceAuthConfigOrExit(REAL_ENV, log, exit);
    expect(exit).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalled();
  });

  it('warns loudly but does not exit for unauthenticated development mode', () => {
    const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    const exit = vi.fn();
    enforceAuthConfigOrExit({ NODE_ENV: 'development' }, log, exit);
    expect(exit).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
    const logged = log.warn.mock.calls.map((c: string[]) => String(c[0])).join('\n');
    expect(logged).not.toMatch(/ARGUS_DEV_TOKEN=/);
  });
});

describe('AuthConfig - mutating API lockdown when AUTH_PASSWORD is unset', () => {
  const noAuth = { NODE_ENV: 'development' as const };

  it('allows GET without a session', () => {
    expect(allowUnauthenticatedRequest({
      method: 'GET', path: '/api/v1/secrets', ip: '10.0.0.5', env: noAuth,
    })).toBe(true);
  });

  it('allows mutating calls from loopback', () => {
    expect(allowUnauthenticatedRequest({
      method: 'POST', path: '/api/v1/autobot/toggle', ip: '127.0.0.1', env: noAuth,
    })).toBe(true);
  });

  it('rejects mutating calls from a remote IP without a dev token', () => {
    expect(allowUnauthenticatedRequest({
      method: 'POST', path: '/api/v1/portfolio/liquidate', ip: '10.0.0.8', env: noAuth,
    })).toBe(false);
  });

  it('allows mutating calls from a remote IP with a valid X-Argus-Dev-Token', () => {
    expect(allowUnauthenticatedRequest({
      method: 'PUT',
      path: '/api/v1/settings',
      ip: '10.0.0.8',
      devTokenHeader: 'unit-test-dev-token-ok',
      env: { ...noAuth, ARGUS_DEV_TOKEN: 'unit-test-dev-token-ok' },
    })).toBe(true);
  });

  it('does NOT allow ARGUS_DEV_TOKEN (or loopback) as a bypass when AUTH_PASSWORD is set', () => {
    expect(allowUnauthenticatedRequest({
      method: 'GET',
      path: '/api/v2/runtime/status',
      ip: '127.0.0.1',
      devTokenHeader: 'unit-test-dev-token-ok',
      env: {
        AUTH_USERNAME: 'admin',
        AUTH_PASSWORD: 'correct-horse-battery-staple',
        ARGUS_DEV_TOKEN: 'unit-test-dev-token-ok',
        NODE_ENV: 'development',
      },
    })).toBe(false);
  });
});
