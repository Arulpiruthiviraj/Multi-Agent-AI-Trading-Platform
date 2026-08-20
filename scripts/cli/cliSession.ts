/**
 * CLI session cookie persistence for Argus HTTP client.
 * Used when AUTH_PASSWORD is set (server ignores ARGUS_DEV_TOKEN in that mode).
 * Never log cookie values or passwords.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SESSION_COOKIE_NAME = 'argus_session';
export const EXIT_AUTH = 5;

/** Prefer ARGUS_CLI_* so operators can point the CLI at a remote engine without overlapping server env. */
export function resolveCliCredentials(env: NodeJS.ProcessEnv = process.env): {
  username: string;
  password: string;
  source: 'ARGUS_CLI_*' | 'AUTH_*';
} | null {
  const cliUser = env.ARGUS_CLI_USER?.trim();
  const cliPass = env.ARGUS_CLI_PASSWORD;
  if (cliUser && cliPass) {
    return { username: cliUser, password: cliPass, source: 'ARGUS_CLI_*' };
  }
  const authUser = env.AUTH_USERNAME?.trim();
  const authPass = env.AUTH_PASSWORD;
  if (authUser && authPass) {
    return { username: authUser, password: authPass, source: 'AUTH_*' };
  }
  return null;
}

export function defaultSessionFilePath(repoRoot: string): string {
  return join(repoRoot, 'data', '.argus_cli_session');
}

export function parseSessionCookieFromSetCookie(setCookieHeaders: string[]): string | null {
  for (const raw of setCookieHeaders) {
    if (!raw) continue;
    const first = raw.split(';')[0]?.trim();
    if (!first) continue;
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (name === SESSION_COOKIE_NAME && value.length > 0) {
      return `${SESSION_COOKIE_NAME}=${value}`;
    }
  }
  return null;
}

export function collectSetCookieHeaders(headers: Headers): string[] {
  const anyHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === 'function') {
    return anyHeaders.getSetCookie();
  }
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

export function readSessionCookie(sessionPath: string): string | null {
  if (!existsSync(sessionPath)) return null;
  try {
    const raw = readFileSync(sessionPath, 'utf8').trim();
    if (!raw) return null;
    // Accept either "argus_session=…" or a single-line cookie pair.
    if (raw.includes('=')) {
      const line = raw.split(/\r?\n/)[0]!.trim();
      const eq = line.indexOf('=');
      const name = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (name === SESSION_COOKIE_NAME && value.length > 0) {
        return `${SESSION_COOKIE_NAME}=${value}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function writeSessionCookie(sessionPath: string, cookiePair: string): void {
  const dir = dirname(sessionPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(sessionPath, `${cookiePair}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(sessionPath, 0o600);
  } catch {
    /* Windows may ignore mode; best-effort */
  }
}

export function clearSessionFile(sessionPath: string): void {
  if (!existsSync(sessionPath)) return;
  try {
    unlinkSync(sessionPath);
  } catch {
    /* ignore */
  }
}

/**
 * Build request auth headers for the CLI.
 * - Session cookie when a local session file exists (required when AUTH_PASSWORD is set on the server).
 * - x-argus-dev-token when ARGUS_DEV_TOKEN is set (only useful when the server has AUTH_PASSWORD unset;
 *   the server ignores this header when AUTH_PASSWORD is configured — not a bypass).
 */
export function buildCliAuthHeaders(opts: {
  sessionPath: string;
  env?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const env = opts.env ?? process.env;
  const headers: Record<string, string> = {};
  const cookie = readSessionCookie(opts.sessionPath);
  if (cookie) headers.Cookie = cookie;
  if (env.ARGUS_DEV_TOKEN) {
    headers['x-argus-dev-token'] = env.ARGUS_DEV_TOKEN;
  }
  return headers;
}

export function unauthorizedMessage(): string {
  return (
    'API unauthorized (HTTP 401). Run `argus login` (uses ARGUS_CLI_USER/ARGUS_CLI_PASSWORD ' +
    'or AUTH_USERNAME/AUTH_PASSWORD), or unset AUTH_PASSWORD for localhost-only no-auth mode. ' +
    'Note: ARGUS_DEV_TOKEN is ignored when AUTH_PASSWORD is set on the server.'
  );
}

/** Redact secrets from strings that might appear in doctor/CLI output. */
export function assertNoSecretLeak(text: string, secrets: string[]): void {
  for (const s of secrets) {
    if (s && s.length >= 4 && text.includes(s)) {
      throw new Error('Secret value must not appear in CLI output');
    }
  }
}
