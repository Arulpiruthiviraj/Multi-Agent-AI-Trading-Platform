/**
 * Alpaca HTTP/WebSocket TLS helpers — Node's default CA store can miss system roots on some
 * Windows dev installs. Prefer NODE_OPTIONS=--use-system-ca at process start; this module
 * retries fetch with tls.getCACertificates('system') when callers opt in.
 */
import tls from 'node:tls';
import https from 'node:https';
import { URL } from 'node:url';

let cachedSystemCa: string[] | null = null;

export function getSystemCaCertificates(): string[] {
  if (!cachedSystemCa) {
    cachedSystemCa = tls.getCACertificates('system') as string[];
  }
  return cachedSystemCa;
}

export function isTlsOrCertificateError(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException & { cause?: unknown; code?: string };
  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(err.message);
    if (err.cause instanceof Error) parts.push(err.cause.message);
  } else {
    parts.push(String(err));
  }
  const joined = parts.join(' | ');
  return (
    /UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_|certificate|SSL|TLS|self signed|DEPTH_ZERO_SELF_SIGNED|ERR_SSL|unable to verify the first certificate/i.test(joined)
    || e.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
    || e.code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
  );
}

function normalizeHeaders(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init?.headers) return out;
  if (init.headers instanceof Headers) {
    init.headers.forEach((v, k) => { out[k] = v; });
    return out;
  }
  if (Array.isArray(init.headers)) {
    for (const [k, v] of init.headers) out[k] = v;
    return out;
  }
  return { ...init.headers };
}

/** node:https fallback when global fetch fails TLS verification. */
function httpsFetchWithSystemCa(urlStr: string, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const method = init?.method || 'GET';
    const headers = normalizeHeaders(init);
    const body = init?.body;

    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        ca: getSystemCaCertificates(),
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') responseHeaders.set(key, value);
            else if (Array.isArray(value)) value.forEach(v => responseHeaders.append(key, v));
          }
          resolve(new Response(text, {
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            headers: responseHeaders,
          }));
        });
      },
    );

    const signal = init?.signal;
    if (signal) {
      if (signal.aborted) {
        req.destroy();
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        return;
      }
      signal.addEventListener('abort', () => {
        req.destroy();
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, { once: true });
    }

    req.on('error', reject);
    if (body != null) {
      req.write(typeof body === 'string' ? body : String(body));
    }
    req.end();
  });
}

/** fetch with system CA store — used by Alpaca REST clients when default fetch fails TLS. */
// ---------------------------------------------------------------------------------------------------------------------------------------------
// SYNTHETIC EXTERNAL-PROVIDER SEAM (2026-10-14). Synthetic certification must run the REAL discovery stack (MarketUniverseScanner, SnapshotScanner,
// OpportunityDiscovery ...) and replace only the external market-data boundary. In a synthetic process (SYNTHETIC_SIMULATION=true) every Alpaca REST
// request is served by the installed provider; with NO provider installed the request is refused (HTTP 503, recorded) instead of reaching the real
// network, so an unintended live call can never happen silently and can be asserted on. Production (flag unset) is byte-for-byte unchanged.
// ---------------------------------------------------------------------------------------------------------------------------------------------
export type SyntheticAlpacaProvider = (url: string, init?: RequestInit) => Promise<Response>;
let syntheticAlpacaProvider: SyntheticAlpacaProvider | null = null;
const blockedSyntheticAlpacaCalls: string[] = [];

function syntheticSeamAllowed(): boolean {
  return process.env.SYNTHETIC_SIMULATION === 'true' || process.env.NODE_ENV === 'test' || !!process.env.VITEST;
}

export function installSyntheticAlpacaProvider(provider: SyntheticAlpacaProvider | null): void {
  if (provider && !syntheticSeamAllowed()) throw new Error('installSyntheticAlpacaProvider is only permitted in a synthetic or test process');
  syntheticAlpacaProvider = provider;
}

/** URLs refused because no synthetic provider was installed (certification asserts this is empty). */
export function getBlockedSyntheticAlpacaCalls(): readonly string[] { return blockedSyntheticAlpacaCalls; }
export function resetBlockedSyntheticAlpacaCalls(): void { blockedSyntheticAlpacaCalls.length = 0; }

export async function alpacaFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input.toString();
  if (syntheticAlpacaProvider) return syntheticAlpacaProvider(url, init);
  if (process.env.SYNTHETIC_SIMULATION === 'true') {
    blockedSyntheticAlpacaCalls.push(url);
    return new Response('SYNTHETIC_NETWORK_BLOCKED', { status: 503, statusText: 'Synthetic mode: no provider installed' });
  }
  try {
    return await fetch(url, init);
  } catch (err) {
    if (!isTlsOrCertificateError(err)) throw err;
  }
  return httpsFetchWithSystemCa(url, init);
}

/** WebSocket options for ws package — pass when constructing Alpaca market-data sockets. */
export function alpacaWebSocketTlsOptions(): { ca: string[] } {
  return { ca: getSystemCaCertificates() };
}
