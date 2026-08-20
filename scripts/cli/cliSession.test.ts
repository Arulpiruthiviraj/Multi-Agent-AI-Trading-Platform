/**
 * Unit tests for CLI session cookie helpers (no engine boot).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildCliAuthHeaders,
  clearSessionFile,
  defaultSessionFilePath,
  parseSessionCookieFromSetCookie,
  readSessionCookie,
  resolveCliCredentials,
  unauthorizedMessage,
  writeSessionCookie,
  SESSION_COOKIE_NAME,
} from './cliSession';

describe('cliSession - credentials', () => {
  it('prefers ARGUS_CLI_USER / ARGUS_CLI_PASSWORD over AUTH_*', () => {
    const c = resolveCliCredentials({
      ARGUS_CLI_USER: 'cli-admin',
      ARGUS_CLI_PASSWORD: 'cli-secret',
      AUTH_USERNAME: 'auth-admin',
      AUTH_PASSWORD: 'auth-secret',
    });
    expect(c).toEqual({
      username: 'cli-admin',
      password: 'cli-secret',
      source: 'ARGUS_CLI_*',
    });
  });

  it('falls back to AUTH_USERNAME / AUTH_PASSWORD', () => {
    const c = resolveCliCredentials({
      AUTH_USERNAME: 'auth-admin',
      AUTH_PASSWORD: 'auth-secret',
    });
    expect(c).toEqual({
      username: 'auth-admin',
      password: 'auth-secret',
      source: 'AUTH_*',
    });
  });

  it('returns null when credentials are incomplete', () => {
    expect(resolveCliCredentials({ AUTH_USERNAME: 'only-user' })).toBeNull();
    expect(resolveCliCredentials({ ARGUS_CLI_PASSWORD: 'only-pass' })).toBeNull();
    expect(resolveCliCredentials({})).toBeNull();
  });
});

describe('cliSession - Set-Cookie parse', () => {
  it('extracts argus_session from Set-Cookie headers', () => {
    const pair = parseSessionCookieFromSetCookie([
      'other=1; Path=/',
      `${SESSION_COOKIE_NAME}=abc-uuid-123; Max-Age=999; Path=/; HttpOnly; SameSite=Lax`,
    ]);
    expect(pair).toBe(`${SESSION_COOKIE_NAME}=abc-uuid-123`);
  });

  it('returns null when cookie is missing', () => {
    expect(parseSessionCookieFromSetCookie(['foo=bar; Path=/'])).toBeNull();
    expect(parseSessionCookieFromSetCookie([])).toBeNull();
  });
});

describe('cliSession - file + headers', () => {
  let dir: string;
  let sessionPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'argus-cli-session-'));
    sessionPath = join(dir, '.argus_cli_session');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes and reads a session cookie without exposing it in default path helper', () => {
    writeSessionCookie(sessionPath, `${SESSION_COOKIE_NAME}=tok-xyz`);
    expect(readSessionCookie(sessionPath)).toBe(`${SESSION_COOKIE_NAME}=tok-xyz`);
    expect(readFileSync(sessionPath, 'utf8')).toContain('tok-xyz');
    expect(defaultSessionFilePath('/repo')).toMatch(/\.argus_cli_session$/);
  });

  it('buildCliAuthHeaders sends Cookie when session file exists', () => {
    writeSessionCookie(sessionPath, `${SESSION_COOKIE_NAME}=tok-for-header`);
    const h = buildCliAuthHeaders({
      sessionPath,
      env: {},
    });
    expect(h.Cookie).toBe(`${SESSION_COOKIE_NAME}=tok-for-header`);
    expect(h['x-argus-dev-token']).toBeUndefined();
  });

  it('may send Cookie and ARGUS_DEV_TOKEN together; DEV_TOKEN is not a session substitute', () => {
    writeSessionCookie(sessionPath, `${SESSION_COOKIE_NAME}=sess`);
    const h = buildCliAuthHeaders({
      sessionPath,
      env: {
        AUTH_PASSWORD: 'server-password',
        ARGUS_DEV_TOKEN: 'not-a-session-bypass',
      },
    });
    expect(h.Cookie).toBe(`${SESSION_COOKIE_NAME}=sess`);
    // Header may be present; server AuthConfig ignores it when AUTH_PASSWORD is set.
    expect(h['x-argus-dev-token']).toBe('not-a-session-bypass');
  });

  it('sends ARGUS_DEV_TOKEN when set (no-auth mutating / remote loopback alternative)', () => {
    const h = buildCliAuthHeaders({
      sessionPath,
      env: { ARGUS_DEV_TOKEN: 'dev-token-for-no-auth' },
    });
    expect(h.Cookie).toBeUndefined();
    expect(h['x-argus-dev-token']).toBe('dev-token-for-no-auth');
  });

  it('clearSessionFile removes the cookie file', () => {
    writeSessionCookie(sessionPath, `${SESSION_COOKIE_NAME}=gone`);
    clearSessionFile(sessionPath);
    expect(existsSync(sessionPath)).toBe(false);
    expect(readSessionCookie(sessionPath)).toBeNull();
  });

  it('rejects garbage session file contents', () => {
    writeFileSync(sessionPath, 'not-a-cookie\n', 'utf8');
    expect(readSessionCookie(sessionPath)).toBeNull();
  });
});

describe('cliSession - messaging', () => {
  it('unauthorized message points at argus login and does not mention using DEV_TOKEN as bypass', () => {
    const msg = unauthorizedMessage();
    expect(msg).toMatch(/argus login/i);
    expect(msg).toMatch(/AUTH_PASSWORD/);
    expect(msg).toMatch(/ignored/i);
  });
});
