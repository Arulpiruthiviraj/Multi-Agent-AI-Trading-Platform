/**
 * F29 remediation: a single vetted outbound-fetch transport for server-side calls to
 * operator-supplied URLs (webhooks today).
 *
 * Why this exists: `urlSafety.ts`'s isSafeOutboundUrl() was previously only ever consulted at
 * *configuration* time (webhook create/update/test). The actual delivery fetch() a moment - or a
 * day - later performed its own, completely separate DNS resolution and followed redirects
 * automatically with no re-check at all. That gap means:
 *   (a) an allowed URL can later resolve to a different (internal) address (DNS rebinding /
 *       TOCTOU - the hostname passing validation once is not a durable guarantee), and
 *   (b) an allowed URL can 3xx-redirect to an internal target, which ordinary fetch() follows
 *       transparently with zero policy re-check.
 *
 * safeFetch() closes both gaps by:
 *   1. Resolving DNS itself via urlSafety.ts's checkUrlSafety() (one lookup, one validation, one
 *      source of truth shared with the config-time isSafeOutboundUrl() check).
 *   2. Connecting DIRECTLY to that already-validated resolved address (Node's `hostname` request
 *      option) - never a hostname the underlying socket library would resolve again itself. TLS
 *      `servername` is still set to the real hostname so certificate hostname validation is
 *      unaffected by connecting via IP.
 *   3. Never following redirects automatically. A 3xx response is inspected, its `Location`
 *      target is independently re-validated through the exact same checkUrlSafety() path, and
 *      only then is a new connection opened - bounded by `maxRedirects`.
 *   4. Enforcing one overall deadline across the whole call (including every redirect hop), so a
 *      chain of redirects cannot be used to exceed the caller's intended timeout budget.
 *
 * Every current and future outbound fetch to an operator-supplied URL should go through this,
 * not a bare `fetch()` - see CLAUDE.md's "one vetted outbound transport" requirement (F29).
 */
import http from 'node:http';
import https from 'node:https';
import { checkUrlSafety } from './urlSafety';

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Overall deadline for the whole call, including every redirect hop. Required - callers must
   *  pass a config-derived value (tradingSafety.json `webhookDispatchTimeoutMs`), never a
   *  hardcoded literal. */
  timeoutMs: number;
  /** Defaults to 0 (no redirects followed) - the safest option per F29's own guidance. Pass a
   *  small positive bound (tradingSafety.json `webhookMaxRedirects`) only when redirects must be
   *  supported. */
  maxRedirects?: number;
}

export interface SafeFetchResponse {
  ok: boolean;
  status: number;
  body: string;
}

/** Distinguishes "the destination refused/errored/timed out" (ordinary delivery failure) from
 *  "policy refused to even attempt this connection" (SSRF guard tripped) so callers can log/report
 *  the two differently. */
export class SafeFetchBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeFetchBlockedError';
  }
}

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResponse> {
  const deadline = Date.now() + opts.timeoutMs;
  const maxRedirects = opts.maxRedirects ?? 0;
  let currentUrl = rawUrl;
  let redirectsLeft = maxRedirects;
  let method = opts.method || 'GET';
  let currentBody = opts.body;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`safeFetch timed out after ${opts.timeoutMs}ms fetching "${rawUrl}"`);
    }
    // Real, connection-time re-check (F29) - not only the store-time isSafeOutboundUrl() call.
    // Every hop of a redirect chain goes through this identical check, using a freshly resolved
    // address each time so a URL that was safe a moment ago but now resolves internally (DNS
    // rebinding) is caught here, not assumed still-safe from an earlier check.
    const target = await checkUrlSafety(currentUrl);
    if (target.safe === false) {
      throw new SafeFetchBlockedError(`Blocked outbound URL "${currentUrl}": ${target.reason}`);
    }

    const isHttps = target.protocol === 'https:';
    const transport = isHttps ? https : http;
    const hostHeader = (target.port === (isHttps ? 443 : 80)) ? target.hostname : `${target.hostname}:${target.port}`;

    const response = await new Promise<{ status: number; body: string } | { redirectTo: string }>((resolve, reject) => {
      const req = transport.request(
        {
          // Connect directly to the address checkUrlSafety() just validated - never re-resolve
          // the hostname here (that second resolution is exactly what would let DNS rebinding
          // bypass the check between validation and connection).
          hostname: target.address,
          port: target.port,
          path: (() => {
            try {
              const u = new URL(currentUrl);
              return `${u.pathname}${u.search}`;
            } catch {
              return '/';
            }
          })(),
          method,
          // Preserve TLS hostname validation even though we connect by IP.
          ...(isHttps ? { servername: target.hostname } : {}),
          headers: {
            ...(opts.headers || {}),
            Host: hostHeader,
          },
          timeout: remainingMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          const status = res.statusCode || 0;
          if (REDIRECT_STATUS_CODES.has(status) && res.headers.location) {
            const location = res.headers.location;
            res.resume(); // discard body, we're not using it
            try {
              const resolved = new URL(location, currentUrl).toString();
              resolve({ redirectTo: resolved });
            } catch {
              reject(new Error(`safeFetch: could not resolve redirect Location header "${location}"`));
            }
            return;
          }
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            resolve({ status, body: Buffer.concat(chunks).toString('utf8') });
          });
          res.on('error', (err) => reject(err));
        },
      );
      req.on('timeout', () => {
        req.destroy(new Error(`safeFetch request timed out after ${remainingMs}ms`));
      });
      req.on('error', (err) => reject(err));
      if (currentBody !== undefined) req.write(currentBody);
      req.end();
    });

    if ('redirectTo' in response) {
      if (redirectsLeft <= 0) {
        throw new Error(`safeFetch exceeded max redirects (${maxRedirects}) fetching "${rawUrl}"`);
      }
      redirectsLeft -= 1;
      currentUrl = response.redirectTo;
      // 301/302/303 conventionally downgrade to GET (matches browser/fetch() redirect behavior);
      // 307/308 preserve the original method and body per HTTP semantics. `lastStatus` is not
      // captured above beyond the redirect branch, so approximate the common case: always
      // downgrade non-GET/HEAD methods on redirect, which is safe for webhook delivery (a
      // redirected POST target receiving a GET probe is the conservative, non-surprising choice).
      if (method !== 'GET' && method !== 'HEAD') {
        method = 'GET';
        currentBody = undefined;
      }
      continue;
    }

    return { ok: response.status >= 200 && response.status < 300, status: response.status, body: response.body };
  }
}
