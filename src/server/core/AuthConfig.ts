/**
 * ==========================================================
 * Module: AuthConfig.ts
 *
 * Purpose:
 * Pure, dependency-free authentication/authorization logic, extracted from server.ts so it can
 * be unit-tested without booting the full Express/Vite/WebSocket stack.
 *
 * Fixes a real authentication bypass found in this codebase's own audit (FINAL_ANALYSIS.md
 * Section 15.12): validateCredentials() used to do `username === AUTH_USERNAME &&
 * password === AUTH_PASSWORD` with no check that AUTH_PASSWORD was actually set. When unset,
 * both sides of both comparisons were `undefined`, so an empty-body POST to /login succeeded
 * and issued a real session cookie.
 *
 * Design: this app's documented behavior (CLAUDE.md) is that authentication is OFF by default
 * for local/single-user use when no password is configured - that convenience is preserved, but
 * made explicit and loud instead of being a side effect of a broken comparison:
 *   - AUTH_PASSWORD unset  -> "no-auth" mode. Login can never succeed (there is no real
 *     credential to check against), and the /api/* gate does not require a session at all -
 *     matching what the WebSocket upgrade path already did. This mode is refused outright in
 *     production (NODE_ENV=production) rather than silently allowed.
 *   - AUTH_PASSWORD set    -> real auth required. AUTH_USERNAME must also be set.
 * ==========================================================
 */

export interface AuthEnv {
  AUTH_USERNAME?: string;
  AUTH_PASSWORD?: string;
  AUTH_SESSION_SECRET?: string;
  NODE_ENV?: string;
}

export const DEFAULT_SESSION_SECRET = 'default_dev_secret_do_not_use_in_prod';

export function isProduction(env: AuthEnv): boolean {
  return env.NODE_ENV === 'production';
}

/** Auth is only "on" when there is a real credential configured to check against. */
export function isAuthEnabled(env: AuthEnv): boolean {
  return !!env.AUTH_PASSWORD;
}

/**
 * Real credential check. Returns false unconditionally when auth is disabled - there is no
 * scenario in which a login attempt should succeed while no real password is configured.
 */
export function validateCredentials(env: AuthEnv, username: unknown, password: unknown): boolean {
  if (!isAuthEnabled(env)) return false;
  if (typeof username !== 'string' || typeof password !== 'string') return false;
  if (username.length === 0 || password.length === 0) return false;
  return username === env.AUTH_USERNAME && password === env.AUTH_PASSWORD;
}

export function isSessionValid(session: { expiresAt: number } | null | undefined, now: number = Date.now()): boolean {
  return !!session && session.expiresAt > now;
}

export interface AuthConfigIssue {
  fatal: boolean;
  message: string;
}

/**
 * Startup validation for security-sensitive configuration. Fatal issues must stop the process
 * before it starts serving requests (mirrors EncryptionService's existing convention of refusing
 * to boot without a real ENCRYPTION_SECRET rather than silently degrading).
 */
export function checkAuthConfig(env: AuthEnv): AuthConfigIssue[] {
  const issues: AuthConfigIssue[] = [];
  const enabled = isAuthEnabled(env);
  const prod = isProduction(env);

  if (prod && !enabled) {
    issues.push({
      fatal: true,
      message: 'NODE_ENV=production but AUTH_PASSWORD is not set. Refusing to start unauthenticated ' +
        'in production. Set AUTH_USERNAME and AUTH_PASSWORD, or run with NODE_ENV=development for ' +
        'local/offline use only.',
    });
  }
  if (enabled && !env.AUTH_USERNAME) {
    issues.push({
      fatal: true,
      message: 'AUTH_PASSWORD is set but AUTH_USERNAME is not. Both must be configured together.',
    });
  }
  if (enabled && (!env.AUTH_SESSION_SECRET || env.AUTH_SESSION_SECRET === DEFAULT_SESSION_SECRET)) {
    issues.push({
      fatal: true,
      message: 'AUTH_PASSWORD is set but AUTH_SESSION_SECRET is missing or left at its insecure ' +
        'default. Generate a real value (see .env.example) and set AUTH_SESSION_SECRET.',
    });
  }
  if (!enabled && !prod) {
    issues.push({
      fatal: false,
      message: 'AUTH_PASSWORD is not set - Argus is running WITHOUT authentication. Every API ' +
        'endpoint is reachable by anyone who can reach this port. This is intended for local-only, ' +
        'single-user development use. Set AUTH_USERNAME and AUTH_PASSWORD before exposing this ' +
        'server to any network.',
    });
  }
  return issues;
}

/** Runs startup validation, logs every issue, and exits the process on any fatal one. */
export function enforceAuthConfigOrExit(
  env: AuthEnv,
  log: { warn: (msg: string) => void; error: (msg: string) => void; info: (msg: string) => void } = console,
  exit: (code: number) => void = (code) => process.exit(code)
): void {
  const issues = checkAuthConfig(env);
  let hasFatal = false;
  for (const issue of issues) {
    if (issue.fatal) {
      hasFatal = true;
      log.error(`[FATAL][SECURITY] ${issue.message}`);
    } else {
      log.warn(`[SECURITY] ${issue.message}`);
    }
  }
  if (hasFatal) {
    exit(1);
    return;
  }
  if (isAuthEnabled(env)) {
    log.info('[SECURITY] Authentication is ENABLED (AUTH_PASSWORD configured).');
  }
}
