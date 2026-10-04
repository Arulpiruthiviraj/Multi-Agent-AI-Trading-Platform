import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, type ApiFetchResult } from '../lib/clientFetch';

/**
 * ==========================================================
 * useApi — the standard way for Argus frontend code to talk
 * to the backend.
 *
 * Before this hook, 59 components each hand-rolled their own
 * fetch(): no timeouts, no 401 handling, no error normalization,
 * and 42 independent setInterval pollers hammering the same
 * endpoints with no deduplication.
 *
 * useApi centralizes all of that on top of apiFetch():
 *  - consistent timeout + session-cookie + 401 handling
 *  - in-flight request deduplication ACROSS hook instances
 *    (two panels polling /api/v2/portfolio share one request)
 *  - schedule-next-after-complete polling (never overlapping),
 *    paused while the document is hidden
 *  - stale-response guards (StrictMode / unmount safe)
 *  - uniform { data, error, loading, refreshing, refetch } shape
 * ==========================================================
 */

export interface UseApiOptions<T> {
  /** Set false to skip the request (e.g. waiting for auth or a tab to be active). */
  enabled?: boolean;
  /** Re-fetch every N ms. Uses schedule-next-after-complete; paused when tab hidden. */
  pollIntervalMs?: number;
  /** Share in-flight GETs to the same path across hook instances. Default true. */
  dedupe?: boolean;
  /** Per-request timeout override (ms). */
  timeoutMs?: number;
  /** Extra fetch init (headers etc.). Body is JSON-encoded when provided as an object. */
  init?: RequestInit;
  /** Value used for `data` before the first response arrives. */
  initialData?: T;
  onSuccess?: (data: T) => void;
  onError?: (error: string, status: number) => void;
}

export interface UseApiResult<T> {
  data: T | undefined;
  /** Human-readable error, or null. */
  error: string | null;
  /** True while the FIRST request is in flight. */
  loading: boolean;
  /** True while any request (initial or poll) is in flight. */
  refreshing: boolean;
  /** True when the last failure was a 401 (session expired). */
  unauthorized: boolean;
  httpStatus: number | null;
  /** Force a re-fetch now (resets the poll schedule). */
  refetch: () => void;
}

// ---- cross-instance in-flight dedup --------------------------------------
// Keyed by method+path. Two panels polling the same endpoint share one
// network request instead of doubling backend load.
const inflight = new Map<string, Promise<ApiFetchResult<unknown>>>();

function dedupeKey(method: string, path: string): string {
  return `${method.toUpperCase()}:${path}`;
}

function dedupedFetch<T>(
  path: string,
  init: RequestInit | undefined,
  timeoutMs: number | undefined,
  useDedupe: boolean,
): Promise<ApiFetchResult<T>> {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (!useDedupe || method !== 'GET') {
    return apiFetch<T>(path, init ?? {}, timeoutMs as number);
  }
  const key = dedupeKey(method, path);
  const existing = inflight.get(key);
  if (existing) return existing as Promise<ApiFetchResult<T>>;
  const p = apiFetch<T>(path, init ?? {}, timeoutMs as number).finally(() => {
    if (inflight.get(key) === p) inflight.delete(key);
  });
  inflight.set(key, p as Promise<ApiFetchResult<unknown>>);
  return p;
}

/** Test seam: how many requests are currently shared in flight. */
export function __inflightCount(): number {
  return inflight.size;
}

export function useApi<T = unknown>(
  path: string | null,
  options: UseApiOptions<T> = {},
): UseApiResult<T> {
  const {
    enabled = true,
    pollIntervalMs,
    dedupe = true,
    timeoutMs,
    init,
    initialData,
    onSuccess,
    onError,
  } = options;

  const [data, setData] = useState<T | undefined>(initialData);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [unauthorized, setUnauthorized] = useState<boolean>(false);
  const [httpStatus, setHttpStatus] = useState<number | null>(null);

  // Guards against stale responses (unmount / path change / StrictMode remount).
  const generationRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef({ enabled, path, pollIntervalMs, dedupe, timeoutMs });
  stateRef.current = { enabled, path, pollIntervalMs, dedupe, timeoutMs };
  const initRef = useRef(init);
  initRef.current = init;
  const cbRef = useRef({ onSuccess, onError });
  cbRef.current = { onSuccess, onError };

  const clearPollTimer = () => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const doFetch = useCallback(async (generation: number, isPoll: boolean) => {
    const { enabled: en, path: p, dedupe: dd, timeoutMs: tm } = stateRef.current;
    if (!en || !p) return;
    if (!isPoll) {
      setLoading(true);
    }
    setRefreshing(true);
    try {
      const res = await dedupedFetch<T>(p, initRef.current, tm, dd);
      if (generationRef.current !== generation) return; // stale — ignore
      setHttpStatus(res.status);
      setUnauthorized(!!res.unauthorized);
      if (res.ok) {
        setData(res.data);
        setError(null);
        cbRef.current.onSuccess?.(res.data);
      } else {
        const msg = res.error || `Request failed (HTTP ${res.status})`;
        setError(msg);
        cbRef.current.onError?.(msg, res.status);
      }
    } catch (e) {
      if (generationRef.current !== generation) return;
      const msg = e instanceof Error ? e.message : 'fetch failed';
      setError(msg);
      setUnauthorized(false);
      setHttpStatus(0);
      cbRef.current.onError?.(msg, 0);
    } finally {
      if (generationRef.current === generation) {
        setLoading(false);
        setRefreshing(false);
        scheduleNext(generation);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleNext = (generation: number) => {
    clearPollTimer();
    const { pollIntervalMs: interval, enabled: en, path: p } = stateRef.current;
    if (!interval || interval <= 0 || !en || !p) return;
    pollTimerRef.current = setTimeout(() => {
      // Visibility-aware: a background tab skips this tick and reschedules,
      // so 40+ pollers don't burn battery/CPU when the terminal isn't visible.
      if (typeof document !== 'undefined' && document.hidden) {
        scheduleNext(generation);
        return;
      }
      void doFetch(generation, true);
    }, interval);
  };

  const refetch = useCallback(() => {
    const generation = ++generationRef.current;
    clearPollTimer();
    void doFetch(generation, false);
  }, [doFetch]);

  useEffect(() => {
    const generation = ++generationRef.current;
    if (enabled && path) {
      void doFetch(generation, false);
    } else {
      setLoading(false);
      setRefreshing(false);
    }
    return () => {
      // Invalidate any response that lands after unmount/path change.
      generationRef.current++;
      clearPollTimer();
    };
    // Intentionally keyed on primitives: path + enabled + pollIntervalMs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, enabled, pollIntervalMs]);

  return { data, error, loading, refreshing, unauthorized, httpStatus, refetch };
}

// ---- mutations ------------------------------------------------------------

export interface UseApiMutationResult<TData, TVars> {
  mutate: (vars: TVars) => Promise<ApiFetchResult<TData>>;
  data: TData | undefined;
  error: string | null;
  loading: boolean;
  unauthorized: boolean;
  reset: () => void;
}

/**
 * Standard mutation hook (POST/PUT/PATCH/DELETE) with the same error
 * normalization as useApi. No dedup — mutations are never shared.
 */
export function useApiMutation<TData = unknown, TVars = unknown>(
  path: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'POST',
  timeoutMs?: number,
): UseApiMutationResult<TData, TVars> {
  const [data, setData] = useState<TData | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reset = useCallback(() => {
    setData(undefined);
    setError(null);
    setLoading(false);
    setUnauthorized(false);
  }, []);

  const mutate = useCallback(
    async (vars: TVars): Promise<ApiFetchResult<TData>> => {
      setLoading(true);
      setError(null);
      const res = await apiFetch<TData>(
        path,
        {
          method,
          body: vars === undefined ? undefined : JSON.stringify(vars),
        },
        timeoutMs as number,
      );
      if (!mountedRef.current) return res;
      setLoading(false);
      setUnauthorized(!!res.unauthorized);
      if (res.ok) {
        setData(res.data);
      } else {
        setError(res.error || `Request failed (HTTP ${res.status})`);
      }
      return res;
    },
    [path, method, timeoutMs],
  );

  return { mutate, data, error, loading, unauthorized, reset };
}
