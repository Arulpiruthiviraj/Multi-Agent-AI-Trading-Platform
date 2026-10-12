/**
 * TimesFmClient - SHADOW / RESEARCH client for the isolated TimesFM service
 * (scripts/timesfm/timesfm_service.py). Disabled by default (TIMESFM_ENABLED !== 'true').
 *
 * Contract:
 *  - Never throws into callers: every outcome is a typed TimesFmResult (OK or a status code).
 *  - Never emits trade ideas, never touches ChiefTrader/RiskEngine/OMS/BrokerManager. The result is
 *    research evidence only; quantiles are forecast-distribution outputs, not calibrated probabilities.
 *  - Point-in-time: bars after the forecast origin are REJECTED (look-ahead guard), duplicates and
 *    out-of-order bars are rejected, non-positive / non-finite closes are rejected.
 *  - Bounded: per-call deadline (AbortController), bounded concurrency + queue, identical in-flight
 *    requests are coalesced onto one underlying call. Loopback URLs only.
 */
export type TimesFmStatus =
  | 'OK'
  | 'DISABLED'
  | 'INVALID_INPUT'
  | 'LOOKAHEAD_REJECTED'
  | 'INSUFFICIENT_HISTORY'
  | 'QUEUE_FULL'
  | 'TIMEOUT'
  | 'SERVICE_UNAVAILABLE'
  | 'MODEL_UNAVAILABLE'
  | 'MALFORMED_RESPONSE';

export interface TimesFmBar { timestampMs: number; close: number }

export interface TimesFmForecast {
  modelId: string;
  symbol: string;
  timeframe: string;
  originMs: number;
  inputCutoffMs: number;
  horizon: number;
  point: number[];
  quantileLevels: Array<number | 'mean'>;
  quantiles: number[][];
  latencyMs: number;
  device: string;
  traceId: string;
  /** Forecast-distribution output only. NOT a calibrated probability of a profitable trade. */
  calibrated: false;
}

export type TimesFmResult =
  | { status: 'OK'; forecast: TimesFmForecast }
  | { status: Exclude<TimesFmStatus, 'OK'>; reason: string };

export interface TimesFmClientOptions {
  enabled: boolean;
  serviceUrl: string;
  timeoutMs: number;
  maxConcurrent: number;
  maxQueue: number;
  minHistory: number;
  fetchImpl?: typeof fetch;
}

export function timesFmOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): TimesFmClientOptions {
  return {
    enabled: env.TIMESFM_ENABLED === 'true',
    serviceUrl: env.TIMESFM_SERVICE_URL || 'http://127.0.0.1:8011',
    timeoutMs: Number(env.TIMESFM_TIMEOUT_MS) || 15000,
    maxConcurrent: Number(env.TIMESFM_MAX_CONCURRENT) || 1,
    maxQueue: Number(env.TIMESFM_MAX_QUEUE) || 4,
    minHistory: Number(env.TIMESFM_MIN_HISTORY) || 32,
  };
}

function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
  } catch {
    return false;
  }
}

export class TimesFmClient {
  private active = 0;
  private waiting = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly inflight = new Map<string, Promise<TimesFmResult>>();
  readonly stats = { requests: 0, ok: 0, failures: 0, lookaheadRejections: 0, coalesced: 0, queueRejections: 0 };

  constructor(private readonly opts: TimesFmClientOptions) {}

  async forecast(args: { symbol: string; timeframe: string; originMs: number; horizon: number; bars: TimesFmBar[] }): Promise<TimesFmResult> {
    this.stats.requests += 1;
    if (!this.opts.enabled) return { status: 'DISABLED', reason: 'TIMESFM_ENABLED is not true' };
    if (!isLoopback(this.opts.serviceUrl)) return { status: 'INVALID_INPUT', reason: 'service URL must be loopback' };
    const pre = this.validate(args);
    if (pre) return pre;
    const key = `${args.symbol}|${args.timeframe}|${args.originMs}|${args.horizon}|${args.bars[args.bars.length - 1].timestampMs}`;
    const existing = this.inflight.get(key);
    if (existing) {
      this.stats.coalesced += 1;
      return existing;
    }
    const p = this.run(args).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private validate(a: { symbol: string; originMs: number; horizon: number; bars: TimesFmBar[] }): TimesFmResult | null {
    if (!a.symbol || !Number.isInteger(a.horizon) || a.horizon < 1) return { status: 'INVALID_INPUT', reason: 'bad symbol/horizon' };
    if (!Number.isFinite(a.originMs)) return { status: 'INVALID_INPUT', reason: 'bad origin' };
    if (a.bars.length < this.opts.minHistory) return { status: 'INSUFFICIENT_HISTORY', reason: `need >= ${this.opts.minHistory} bars, got ${a.bars.length}` };
    let prev = -Infinity;
    for (const b of a.bars) {
      if (!Number.isFinite(b.timestampMs) || !Number.isFinite(b.close) || b.close <= 0) return { status: 'INVALID_INPUT', reason: 'non-finite or non-positive bar' };
      if (b.timestampMs > a.originMs) {
        this.stats.lookaheadRejections += 1;
        return { status: 'LOOKAHEAD_REJECTED', reason: `bar at ${b.timestampMs} is after forecast origin ${a.originMs}` };
      }
      if (b.timestampMs <= prev) return { status: 'INVALID_INPUT', reason: 'bars must be strictly increasing (duplicate or out-of-order timestamp)' };
      prev = b.timestampMs;
    }
    return null;
  }

  private async acquire(): Promise<boolean> {
    if (this.active < this.opts.maxConcurrent) {
      this.active += 1;
      return true;
    }
    if (this.waiting >= this.opts.maxQueue) return false;
    this.waiting += 1;
    await new Promise<void>((r) => this.waiters.push(r));
    this.waiting -= 1;
    this.active += 1;
    return true;
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }

  private async run(a: { symbol: string; timeframe: string; originMs: number; horizon: number; bars: TimesFmBar[] }): Promise<TimesFmResult> {
    if (!(await this.acquire())) {
      this.stats.queueRejections += 1;
      return { status: 'QUEUE_FULL', reason: 'TimesFM client queue full' };
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs);
    try {
      const f = this.opts.fetchImpl ?? fetch;
      const res = await f(`${this.opts.serviceUrl}/forecast`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ctl.signal,
        body: JSON.stringify({
          symbol: a.symbol, timeframe: a.timeframe, origin: a.originMs, horizon: a.horizon,
          closes: a.bars.map((b) => b.close), timestamps: a.bars.map((b) => b.timestampMs),
        }),
      });
      const body: any = await res.json().catch(() => null);
      if (!res.ok) {
        this.stats.failures += 1;
        const code = String(body?.code ?? '');
        if (res.status === 503) return { status: code === 'MODEL_NOT_INSTALLED' || code === 'LOAD_FAILED' || code === 'MODEL_NOT_APPROVED' ? 'MODEL_UNAVAILABLE' : 'SERVICE_UNAVAILABLE', reason: String(body?.error ?? res.status) };
        if (res.status === 429) return { status: 'QUEUE_FULL', reason: 'service queue full' };
        if (res.status === 422) return { status: 'INVALID_INPUT', reason: String(body?.error ?? 'rejected by service') };
        return { status: 'SERVICE_UNAVAILABLE', reason: `HTTP ${res.status}` };
      }
      const checked = this.checkResponse(body, a);
      if (typeof checked === 'string') {
        this.stats.failures += 1;
        return { status: 'MALFORMED_RESPONSE', reason: checked };
      }
      this.stats.ok += 1;
      return { status: 'OK', forecast: checked };
    } catch (e: any) {
      this.stats.failures += 1;
      if (e?.name === 'AbortError') return { status: 'TIMEOUT', reason: `no response within ${this.opts.timeoutMs}ms` };
      return { status: 'SERVICE_UNAVAILABLE', reason: String(e?.message ?? e) };
    } finally {
      clearTimeout(timer);
      this.release();
    }
  }

  private checkResponse(b: any, a: { symbol: string; timeframe: string; originMs: number; horizon: number; bars: TimesFmBar[] }): TimesFmForecast | string {
    if (!b || !Array.isArray(b.point) || b.point.length !== a.horizon) return 'point forecast has wrong length';
    if (!b.point.every((x: unknown) => typeof x === 'number' && Number.isFinite(x))) return 'point forecast contains non-finite values';
    const q = b.quantiles?.values;
    if (!Array.isArray(q) || q.length !== a.horizon) return 'quantile matrix has wrong horizon length';
    for (const row of q) {
      if (!Array.isArray(row) || row.length !== 10 || !row.every((x: unknown) => typeof x === 'number' && Number.isFinite(x))) return 'quantile row malformed';
      const deciles = row.slice(1);
      for (let i = 1; i < deciles.length; i++) if (deciles[i] < deciles[i - 1]) return 'quantiles are not monotonic';
    }
    if (typeof b.inputCutoff === 'number' && b.inputCutoff > a.originMs) return 'service reports input cutoff after forecast origin';
    return {
      modelId: String(b.modelId), symbol: a.symbol, timeframe: a.timeframe, originMs: a.originMs,
      inputCutoffMs: a.bars[a.bars.length - 1].timestampMs, horizon: a.horizon, point: b.point,
      quantileLevels: b.quantiles.levels, quantiles: q, latencyMs: Number(b.latencyMs) || 0,
      device: String(b.device ?? 'unknown'), traceId: String(b.traceId ?? ''), calibrated: false,
    };
  }
}
