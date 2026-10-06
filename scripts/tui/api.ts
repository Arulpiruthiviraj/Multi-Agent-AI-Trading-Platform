/**
 * TUI data client (2026-10-06): ONE thin wrapper over existing Argus HTTP
 * endpoints. Presentation/controller layer only.
 *
 * HARD RULES:
 * - No direct DB queries.
 * - No imports of BrokerManager, broker adapters, OMS, RiskEngine, TradingEngine.
 * - Read-only: only GET endpoints. Any future mutating action must go through
 *   the same API path the CLI commands use, with confirmation.
 */
import { useEffect, useRef, useState } from 'react';

export type ApiResult<T> = {
  data: T | null;
  error: string | null;
  updatedAt: number | null;
};

async function getJson<T>(base: string, path: string, timeoutMs = 8000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Minimal typed surface over existing endpoints. Shapes are `any`-tolerant: the
 *  TUI renders defensively (missing fields show as dim "—"), never crashes. */
export class TuiApiClient {
  constructor(private base: string) {}

  status() { return getJson<any>(this.base, '/api/v2/runtime/status'); }
  health() { return getJson<any>(this.base, '/api/v2/runtime/health'); }
  readiness() { return getJson<any>(this.base, '/api/v2/live-readiness'); }
  portfolio() { return getJson<any>(this.base, '/api/v2/portfolio'); }
  orders() { return getJson<any>(this.base, '/api/v2/orders'); }
  observability() { return getJson<any>(this.base, '/api/v2/observability/health'); }
  marketStatus() { return getJson<any>(this.base, '/api/v2/market/status'); }
  agentHealth() { return getJson<any>(this.base, '/api/v2/agents/health'); }
  consensus() { return getJson<any>(this.base, '/api/v2/consensus/recent'); }
  risk() { return getJson<any>(this.base, '/api/v2/risk/status'); }
  events() { return getJson<any>(this.base, '/api/v2/observability/events?limit=50'); }
}

/**
 * Polling hook with request dedup (never overlapping) and clean unmount.
 * intervalMs per screen: health/fast 1500-2000ms, slow diagnostics 8000ms.
 */
export function usePoll<T>(client: TuiApiClient | null, fn: (c: TuiApiClient) => Promise<T>, intervalMs: number, refreshTick = 0): ApiResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const inFlight = useRef(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!client) return;
    let alive = true;
    const tick = async () => {
      if (!alive || inFlight.current) return; // dedup: skip if previous poll still running
      inFlight.current = true;
      try {
        const d = await fnRef.current(client);
        if (!alive) return;
        setData(d);
        setError(null);
        setUpdatedAt(Date.now());
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        inFlight.current = false;
      }
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client, intervalMs, refreshTick]);

  return { data, error, updatedAt };
}
