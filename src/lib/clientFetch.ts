/**
 * Browser-side API helpers — always relative origin + session cookies.
 * Remote mobile (Tailscale / LAN IP) must never hardcode localhost.
 */

export function resolveWebSocketUrl(): string {
  if (typeof window === 'undefined') return 'ws://127.0.0.1/ws';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export type ApiFetchResult<T = unknown> = {
  ok: boolean;
  status: number;
  data: T;
  error?: string;
  unauthorized?: boolean;
};

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/** Relative-path fetch with session cookie (Tailscale / LAN safe). */
export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<ApiFetchResult<T>> {
  const url = path.startsWith('/') ? path : `/${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      credentials: 'include',
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.body && !(init.headers as Record<string, string>)?.['Content-Type']
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const data = (await res.json().catch(() => ({}))) as T;
    if (res.status === 401) {
      return {
        ok: false,
        status: 401,
        data,
        unauthorized: true,
        error: 'Session expired — please log in again.',
      };
    }
    if (!res.ok) {
      const errBody = data as Record<string, unknown>;
      return {
        ok: false,
        status: res.status,
        data,
        error: String(errBody?.error || errBody?.reason || `HTTP ${res.status}`),
      };
    }
    return { ok: true, status: res.status, data };
  } catch (e: unknown) {
    const message = e instanceof Error
      ? (e.name === 'AbortError' ? 'Request timed out' : e.message)
      : 'fetch failed';
    return { ok: false, status: 0, data: {} as T, error: message };
  } finally {
    clearTimeout(timer);
  }
}
