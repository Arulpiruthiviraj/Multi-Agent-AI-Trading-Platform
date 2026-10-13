/**
 * ibkrHistoricalScheduler.ts - intent-priority, bounded, coalescing scheduler for IBKR historical-data requests.
 *
 * Why (2026-10-13 runtime evidence): IBKR serves historical data one request at a time, and the old single FIFO promise
 * chain let weeks-old research/backfill 1Min windows (TIMEOUT/EMPTY after 15-56 s each) sit AHEAD of live current-session
 * Quant requests: live requests waited a median 10.9 s (p95 38.7 s) for a median 0.3 s of service, and 86.7% of
 * regular-session Quant evaluations hit the 8 s intraday deadline. The cause was queueing behind background work, not IBKR
 * slowness itself. This module replaces the chain with:
 *
 *   P0 POSITION_DATA          data an open position's protection depends on
 *   P1 QUANT_ON_DEMAND        current-session on-demand Quant evaluation
 *   P1 QUANT_SCHEDULED        current-session scheduled Quant evaluation
 *   P2 RECENT_CACHE_REFRESH   recent-window refresh with no live evaluation waiting
 *   P3 RESEARCH_BACKFILL      outcome grading / missed-opportunity / backfill of older windows
 *
 * Guarantees: strict priority between classes (FIFO inside a class); a running P2/P3 request is PREEMPTED (cancelled and
 * re-queued) when a P0/P1 request arrives; identical requests coalesce onto one provider request (and promote it to the
 * highest priority among their waiters); every class has a queue-size bound and a queue-wait expiry, so an unserved request
 * is discarded explicitly (never silently, never unbounded); waiters can abandon with an AbortSignal and a request nobody
 * waits for any more is discarded before service (or cancelled once running past a short grace). One request is ever on the
 * wire at a time, so IBKR pacing is never made worse. Pure scheduling - it never fabricates bars; executor errors propagate.
 */

export type HistoricalIntent =
  | 'POSITION_DATA'
  | 'QUANT_ON_DEMAND'
  | 'QUANT_SCHEDULED'
  | 'RECENT_CACHE_REFRESH'
  | 'RESEARCH_BACKFILL';

export const HISTORICAL_INTENT_PRIORITY: Record<HistoricalIntent, 0 | 1 | 2 | 3> = {
  POSITION_DATA: 0,
  QUANT_ON_DEMAND: 1,
  QUANT_SCHEDULED: 1,
  RECENT_CACHE_REFRESH: 2,
  RESEARCH_BACKFILL: 3,
};

export type SchedulerOutcome =
  | 'SUCCESS' | 'EMPTY' | 'TIMEOUT' | 'ERROR'
  | 'DROPPED_QUEUE_FULL' | 'DROPPED_QUEUE_STALE' | 'DISCARDED_ABANDONED' | 'CANCELLED_ABANDONED' | 'PREEMPTED_REQUEUED';

export interface HistoricalJob {
  key: string;
  symbol: string;
  timeframe: string;
  startMs: number;
  endMs: number;
  intent: HistoricalIntent;
}

export interface ExecControl {
  /** The executor registers how to cancel the in-flight provider request (e.g. ib.cancelHistoricalData). */
  setCancel(fn: () => void): void;
}

export interface TimingRecord {
  job: HistoricalJob;
  outcome: SchedulerOutcome;
  queueWaitMs: number;
  serviceMs: number;
  totalMs: number;
  barCount: number;
  queueDepthAtEnqueue: number;
  priority: 0 | 1 | 2 | 3;
  intent: HistoricalIntent;
  coalescedWaiters: number;
}

export interface SchedulerLimits {
  maxQueued: Record<0 | 1 | 2 | 3, number>;
  /** Max time a request may wait for its turn before being discarded unserved, per priority. null = never expires. */
  maxQueueWaitMs: Record<0 | 1 | 2 | 3, number | null>;
  /** A running P2/P3 request is preempted only after it has been on the wire this long (avoids cancelling near-complete work). */
  preemptGraceMs: number;
  /** A running request nobody waits for is cancelled this long after the last waiter abandoned. */
  abandonedCancelGraceMs: number;
  /** A preempted request is re-queued at most this many times, then rejected. */
  maxPreemptions: number;
}

export interface SchedulerDeps<T> {
  exec: (job: HistoricalJob, ctl: ExecControl) => Promise<T>;
  barCount: (value: T) => number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  onTiming?: (rec: TimingRecord) => void;
}

interface Waiter<T> {
  resolve: (v: T) => void;
  reject: (e: Error) => void;
  signal?: AbortSignal;
  abandoned: boolean;
  onAbort?: () => void;
}

interface Item<T> {
  job: HistoricalJob;
  priority: 0 | 1 | 2 | 3;
  enqueuedAtMs: number;
  startedAtMs: number | null;
  waiters: Array<Waiter<T>>;
  queueDepthAtEnqueue: number;
  preemptions: number;
  cancel: (() => void) | null;
  abandonTimer: unknown;
  preemptedFlag: boolean;
}

export interface SchedulerStats {
  depthByPriority: [number, number, number, number];
  depthTotal: number;
  runningIntent: HistoricalIntent | null;
  oldestQueuedAgeMs: number | null;
  oldestQueuedAgeMsByPriority: [number | null, number | null, number | null, number | null];
  counters: {
    submitted: number; coalesced: number; promoted: number; droppedQueueFull: number; expired: number;
    discardedAbandoned: number; cancelledAbandoned: number; preempted: number; completed: number;
  };
  maxDepthObserved: number;
}

export class HistoricalRequestScheduler<T> {
  private readonly queues: [Array<Item<T>>, Array<Item<T>>, Array<Item<T>>, Array<Item<T>>] = [[], [], [], []];
  private readonly byKey = new Map<string, Item<T>>();
  private running: Item<T> | null = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;
  private maxDepthObserved = 0;
  private readonly counters = {
    submitted: 0, coalesced: 0, promoted: 0, droppedQueueFull: 0, expired: 0,
    discardedAbandoned: 0, cancelledAbandoned: 0, preempted: 0, completed: 0,
  };

  constructor(private readonly deps: SchedulerDeps<T>, private readonly limits: SchedulerLimits) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => { const h = setTimeout(fn, ms); (h as any)?.unref?.(); return h; });
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as any));
  }

  private depthTotal(): number {
    return this.queues[0].length + this.queues[1].length + this.queues[2].length + this.queues[3].length;
  }

  submit(job: HistoricalJob, opts: { signal?: AbortSignal } = {}): Promise<T> {
    this.counters.submitted++;
    const priority = HISTORICAL_INTENT_PRIORITY[job.intent];
    const existing = this.byKey.get(job.key);
    if (existing) {
      // Coalesce: one provider request serves every identical caller; the request takes the best priority among them.
      this.counters.coalesced++;
      const waiterPromise = this.addWaiter(existing, opts.signal);
      if (priority < existing.priority && this.queues[existing.priority].includes(existing)) {
        this.queues[existing.priority].splice(this.queues[existing.priority].indexOf(existing), 1);
        existing.priority = priority;
        existing.job = { ...existing.job, intent: job.intent };
        this.queues[priority].push(existing);
        this.counters.promoted++;
      } else if (priority < existing.priority) {
        existing.priority = priority; // already running: nothing to reorder, but record the stronger need
      }
      this.maybePreemptFor(existing.priority);
      this.pump();
      return waiterPromise;
    }
    const depthAtEnqueue = this.queues[priority].length;
    if (depthAtEnqueue >= this.limits.maxQueued[priority]) {
      this.counters.droppedQueueFull++;
      this.emitDropped(job, priority, 'DROPPED_QUEUE_FULL', depthAtEnqueue);
      return Promise.reject(new Error(`IBKR_HISTORICAL_QUEUE_FULL: ${depthAtEnqueue} P${priority} requests already waiting (max ${this.limits.maxQueued[priority]}); ${job.symbol} ${job.timeframe} (${job.intent}) not queued.`));
    }
    const item: Item<T> = {
      job, priority, enqueuedAtMs: this.now(), startedAtMs: null, waiters: [], queueDepthAtEnqueue: depthAtEnqueue,
      preemptions: 0, cancel: null, abandonTimer: null, preemptedFlag: false,
    };
    const p = this.addWaiter(item, opts.signal);
    this.byKey.set(job.key, item);
    this.queues[priority].push(item);
    this.maxDepthObserved = Math.max(this.maxDepthObserved, this.depthTotal());
    this.maybePreemptFor(priority);
    this.pump();
    return p;
  }

  private addWaiter(item: Item<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const w: Waiter<T> = { resolve, reject, signal, abandoned: false };
      if (signal) {
        const onAbort = () => { w.abandoned = true; this.onWaiterAbandoned(item); };
        w.onAbort = onAbort;
        if (signal.aborted) { w.abandoned = true; }
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      item.waiters.push(w);
      if (w.abandoned) this.onWaiterAbandoned(item);
    });
  }

  private liveWaiters(item: Item<T>): number {
    return item.waiters.filter((w) => !w.abandoned).length;
  }

  private onWaiterAbandoned(item: Item<T>): void {
    if (this.liveWaiters(item) > 0) return;
    const queued = this.queues[item.priority].indexOf(item);
    if (queued >= 0) {
      // Nobody waits for it and it never started: discard before service.
      this.queues[item.priority].splice(queued, 1);
      this.byKey.delete(item.job.key);
      this.counters.discardedAbandoned++;
      this.emit(item, 'DISCARDED_ABANDONED', 0, 0);
      this.rejectAll(item, new Error(`IBKR_HISTORICAL_ABANDONED: caller gave up on ${item.job.symbol} ${item.job.timeframe} before service began; discarded.`));
      return;
    }
    if (this.running === item && !item.abandonTimer) {
      item.abandonTimer = this.setTimer(() => {
        item.abandonTimer = null;
        if (this.running === item && this.liveWaiters(item) === 0 && item.cancel) {
          this.counters.cancelledAbandoned++;
          item.cancel();
        }
      }, this.limits.abandonedCancelGraceMs);
    }
  }

  private maybePreemptFor(incomingPriority: number): void {
    const r = this.running;
    if (!r || incomingPriority > 1 || r.priority < 2 || !r.cancel || r.startedAtMs === null) return;
    const ran = this.now() - r.startedAtMs;
    const doIt = () => {
      if (this.running !== r || !r.cancel) return;
      r.preemptedFlag = true;
      this.counters.preempted++;
      r.cancel();
    };
    if (ran >= this.limits.preemptGraceMs) doIt();
    else this.setTimer(doIt, this.limits.preemptGraceMs - ran);
  }

  private rejectAll(item: Item<T>, err: Error): void {
    for (const w of item.waiters) {
      if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
      w.reject(err);
    }
    item.waiters = [];
  }

  private resolveAll(item: Item<T>, value: T): void {
    for (const w of item.waiters) {
      if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
      w.resolve(value);
    }
    item.waiters = [];
  }

  private emit(item: Item<T>, outcome: SchedulerOutcome, serviceMs: number, barCount: number): void {
    const t = this.now();
    try {
      this.deps.onTiming?.({
        job: item.job, outcome,
        queueWaitMs: Math.max(0, (item.startedAtMs ?? t) - item.enqueuedAtMs),
        serviceMs, totalMs: Math.max(0, t - item.enqueuedAtMs), barCount,
        queueDepthAtEnqueue: item.queueDepthAtEnqueue, priority: item.priority, intent: item.job.intent,
        coalescedWaiters: Math.max(0, item.waiters.length - 1),
      });
    } catch { /* diagnostics must never affect delivery */ }
  }

  private emitDropped(job: HistoricalJob, priority: 0 | 1 | 2 | 3, outcome: SchedulerOutcome, depth: number): void {
    try {
      this.deps.onTiming?.({ job, outcome, queueWaitMs: 0, serviceMs: 0, totalMs: 0, barCount: 0, queueDepthAtEnqueue: depth, priority, intent: job.intent, coalescedWaiters: 0 });
    } catch { /* ignore */ }
  }

  private nextItem(): Item<T> | null {
    for (let p = 0 as 0 | 1 | 2 | 3; p <= 3; p = (p + 1) as 0 | 1 | 2 | 3) {
      const q = this.queues[p];
      while (q.length > 0) {
        const item = q.shift()!;
        const maxWait = this.limits.maxQueueWaitMs[p];
        if (this.liveWaiters(item) === 0) {
          this.byKey.delete(item.job.key);
          this.counters.discardedAbandoned++;
          this.emit(item, 'DISCARDED_ABANDONED', 0, 0);
          this.rejectAll(item, new Error(`IBKR_HISTORICAL_ABANDONED: ${item.job.symbol} ${item.job.timeframe} abandoned before service; discarded.`));
          continue;
        }
        if (maxWait !== null && this.now() - item.enqueuedAtMs > maxWait) {
          this.byKey.delete(item.job.key);
          this.counters.expired++;
          this.emit(item, 'DROPPED_QUEUE_STALE', 0, 0);
          this.rejectAll(item, new Error(`IBKR_HISTORICAL_QUEUE_STALE: ${item.job.symbol} ${item.job.timeframe} (${item.job.intent}) waited ${this.now() - item.enqueuedAtMs}ms (max ${maxWait}ms); dropped unserved.`));
          continue;
        }
        return item;
      }
    }
    return null;
  }

  private pump(): void {
    if (this.running) return;
    const item = this.nextItem();
    if (!item) return;
    this.running = item;
    item.startedAtMs = this.now();
    item.preemptedFlag = false;
    item.cancel = null;
    const ctl: ExecControl = { setCancel: (fn) => { item.cancel = fn; } };
    let result: Promise<T>;
    try { result = this.deps.exec(item.job, ctl); } catch (e) { result = Promise.reject(e); }
    result.then(
      (value) => this.finish(item, { ok: true, value }),
      (error) => this.finish(item, { ok: false, error: error instanceof Error ? error : new Error(String(error)) }),
    );
  }

  private finish(item: Item<T>, res: { ok: true; value: T } | { ok: false; error: Error }): void {
    const startedAt = item.startedAtMs ?? this.now();
    const serviceMs = Math.max(0, this.now() - startedAt);
    if (item.abandonTimer) { this.clearTimer(item.abandonTimer); item.abandonTimer = null; }
    this.running = null;
    item.cancel = null;
    if (!res.ok && item.preemptedFlag) {
      // Preempted by a higher-priority arrival: re-queue at the FRONT of its class (bounded attempts), do not fail the waiters.
      item.preemptedFlag = false;
      item.preemptions++;
      this.emit(item, 'PREEMPTED_REQUEUED', serviceMs, 0);
      if (item.preemptions <= this.limits.maxPreemptions && this.liveWaiters(item) > 0) {
        item.startedAtMs = null;
        item.enqueuedAtMs = this.now();
        this.queues[item.priority].unshift(item);
      } else {
        this.byKey.delete(item.job.key);
        this.rejectAll(item, new Error(`IBKR_HISTORICAL_PREEMPTED: ${item.job.symbol} ${item.job.timeframe} (${item.job.intent}) preempted ${item.preemptions}x by live-session work; retry later.`));
      }
      this.pump();
      return;
    }
    this.byKey.delete(item.job.key);
    this.counters.completed++;
    if (res.ok === true) {
      const n = this.deps.barCount((res as { ok: true; value: T }).value);
      this.emit(item, n > 0 ? 'SUCCESS' : 'EMPTY', serviceMs, n);
      this.resolveAll(item, (res as { ok: true; value: T }).value);
    } else {
      const error = (res as { ok: false; error: Error }).error;
      const abandoned = this.liveWaiters(item) === 0;
      this.emit(item, abandoned ? 'CANCELLED_ABANDONED' : /timeout/i.test(error.message) ? 'TIMEOUT' : 'ERROR', serviceMs, 0);
      this.rejectAll(item, error);
    }
    this.pump();
  }

  getStats(): SchedulerStats {
    const now = this.now();
    const ages = this.queues.map((q) => (q.length ? Math.max(...q.map((i) => now - i.enqueuedAtMs)) : null)) as SchedulerStats['oldestQueuedAgeMsByPriority'];
    const nonNull = ages.filter((a): a is number => a !== null);
    return {
      depthByPriority: [this.queues[0].length, this.queues[1].length, this.queues[2].length, this.queues[3].length],
      depthTotal: this.depthTotal(),
      runningIntent: this.running?.job.intent ?? null,
      oldestQueuedAgeMs: nonNull.length ? Math.max(...nonNull) : null,
      oldestQueuedAgeMsByPriority: ages,
      counters: { ...this.counters },
      maxDepthObserved: this.maxDepthObserved,
    };
  }
}

/** What the IBKR session reports to its historical-timing handler for every request outcome. */
export interface HistoricalDataTimingDetail {
  symbol: string;
  timeframe: string;
  startMs: number;
  endMs: number;
  queueWaitMs: number;
  serviceMs: number;
  totalMs: number;
  outcome: SchedulerOutcome;
  barCount: number;
  queueDepthAtEnqueue: number;
  intent: HistoricalIntent;
  priority: number;
  coalescedWaiters: number;
}
