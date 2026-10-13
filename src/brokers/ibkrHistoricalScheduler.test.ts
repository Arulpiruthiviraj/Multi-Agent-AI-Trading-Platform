import { describe, it, expect } from 'vitest';
import {
  HistoricalRequestScheduler, type HistoricalJob, type HistoricalIntent, type SchedulerLimits, type TimingRecord,
} from './ibkrHistoricalScheduler';

/**
 * 2026-10-13 regression for the proven runtime defect: weeks-old research/backfill 1Min windows (15-56 s each) sat AHEAD of
 * live current-session Quant requests in IBKR's single serialized queue (live waits: median 10.9 s, p95 38.7 s). Deterministic
 * harness: manual clock, manual timers, and an executor whose requests complete only when the test says so.
 */
interface Deferred { resolve: (bars: number[]) => void; reject: (e: Error) => void; job: HistoricalJob; cancelled: boolean }

function harness(overrides: Partial<SchedulerLimits> = {}) {
  let t = 1_000_000;
  const timers: Array<{ at: number; fn: () => void; id: number; dead: boolean }> = [];
  let timerSeq = 0;
  const started: Deferred[] = [];
  const timings: TimingRecord[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const limits: SchedulerLimits = {
    maxQueued: { 0: 24, 1: 24, 2: 48, 3: 500 },
    maxQueueWaitMs: { 0: 60_000, 1: 16_000, 2: 120_000, 3: 900_000 },
    preemptGraceMs: 500, abandonedCancelGraceMs: 2_000, maxPreemptions: 3,
    ...overrides,
  };
  const sched = new HistoricalRequestScheduler<number[]>({
    now: () => t,
    setTimer: (fn, ms) => { const h = { at: t + ms, fn, id: ++timerSeq, dead: false }; timers.push(h); return h; },
    clearTimer: (h) => { (h as any).dead = true; },
    barCount: (b) => b.length,
    onTiming: (r) => timings.push(r),
    exec: (job, ctl) => new Promise<number[]>((resolve, reject) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      const d: Deferred = { job, cancelled: false, resolve: (b) => { inFlight--; resolve(b); }, reject: (e) => { inFlight--; reject(e); } };
      ctl.setCancel(() => { d.cancelled = true; d.reject(new Error('IBKR_HISTORICAL_CANCELLED')); });
      started.push(d);
    }),
  }, limits);
  const advance = (ms: number) => {
    t += ms;
    for (const h of [...timers].sort((a, b) => a.at - b.at)) {
      if (!h.dead && h.at <= t) { h.dead = true; h.fn(); }
    }
  };
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return { sched, started, timings, advance, flush, now: () => t, maxInFlight: () => maxInFlight };
}

const job = (symbol: string, intent: HistoricalIntent, startMs = 1, endMs = 2, tf = '1Min'): HistoricalJob =>
  ({ key: `${symbol}|${tf}|${startMs}|${endMs}`, symbol, timeframe: tf, startMs, endMs, intent });
const settle = (p: Promise<unknown>) => p.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e: String(e.message) }));

describe('HistoricalRequestScheduler: live-session work is never queued behind background research', () => {
  it('FAILURE MODE: several 40 s backfill requests in front, then live 1Min requests - the live ones run next (backfill preempted), not after the whole backlog', async () => {
    const h = harness();
    const backfill = ['OLD1', 'OLD2', 'OLD3', 'OLD4', 'OLD5'].map((s, i) => settle(h.sched.submit(job(s, 'RESEARCH_BACKFILL', 100 + i, 200 + i))));
    await h.flush();
    expect(h.started.map((d) => d.job.symbol)).toEqual(['OLD1']); // the first backfill is on the wire (a slow one)
    h.advance(1_000); // it has been running long enough to be preemptible
    const live1 = settle(h.sched.submit(job('SPY', 'QUANT_ON_DEMAND')));
    const live2 = settle(h.sched.submit(job('QQQ', 'QUANT_SCHEDULED')));
    await h.flush();
    expect(h.started[0].cancelled).toBe(true);                       // OLD1 cancelled (preempted)
    expect(h.started.map((d) => d.job.symbol)).toEqual(['OLD1', 'SPY']); // the live request is next - ahead of OLD2..OLD5
    h.started[1].resolve([1, 2, 3]); await h.flush();
    h.started[2].resolve([1, 2]); await h.flush();
    expect(h.started.map((d) => d.job.symbol).slice(0, 3)).toEqual(['OLD1', 'SPY', 'QQQ']); // QQQ before any backfill resumes
    expect(await live1).toMatchObject({ ok: true });
    expect(await live2).toMatchObject({ ok: true });
    const spy = h.timings.find((r) => r.job.symbol === 'SPY' && r.outcome === 'SUCCESS')!;
    expect(spy.queueWaitMs).toBeLessThan(2_000);                      // not 40 s x backlog
    expect(spy.priority).toBe(1);
    // the preempted backfill is re-queued, not lost: it resumes only after live work drains
    await h.flush();
    expect(h.started.map((d) => d.job.symbol)[3]).toBe('OLD1');
    void backfill;
  });

  it('a running P3 request is not cancelled if it is nearly done (preempt grace), and live work still goes next', async () => {
    const h = harness();
    void settle(h.sched.submit(job('OLD', 'RESEARCH_BACKFILL')));
    await h.flush();
    void settle(h.sched.submit(job('SPY', 'QUANT_ON_DEMAND')));
    await h.flush();
    expect(h.started[0].cancelled).toBe(false);
    h.started[0].resolve([1]); await h.flush();
    expect(h.started.map((d) => d.job.symbol)).toEqual(['OLD', 'SPY']);
  });

  it('strict class order: P0 position data > P1 quant (FIFO within) > P2 recent refresh > P3 backfill', async () => {
    const h = harness();
    void settle(h.sched.submit(job('RUN', 'QUANT_SCHEDULED', 1, 2)));
    await h.flush(); // RUN occupies the wire
    for (const [s, i] of [['BF', 'RESEARCH_BACKFILL'], ['REFRESH', 'RECENT_CACHE_REFRESH'], ['SCHED', 'QUANT_SCHEDULED'], ['POS', 'POSITION_DATA'], ['DEMAND', 'QUANT_ON_DEMAND']] as const) {
      void settle(h.sched.submit(job(s, i, 5, 6)));
    }
    const order: string[] = [];
    for (let i = 0; i < 5; i++) {
      h.started[h.started.length - 1].resolve([1]); await h.flush();
      order.push(h.started[h.started.length - 1].job.symbol);
    }
    expect(order).toEqual(['POS', 'SCHED', 'DEMAND', 'REFRESH', 'BF']);
  });

  it('only one provider request is ever on the wire (IBKR pacing is never made worse)', async () => {
    const h = harness();
    for (let i = 0; i < 12; i++) void settle(h.sched.submit(job(`S${i}`, i % 2 ? 'QUANT_ON_DEMAND' : 'RECENT_CACHE_REFRESH', i, i + 1)));
    for (let i = 0; i < 12; i++) { await h.flush(); h.started[h.started.length - 1].resolve([1]); }
    await h.flush();
    expect(h.maxInFlight()).toBe(1);
  });
});

describe('HistoricalRequestScheduler: coalescing', () => {
  it('identical concurrent requests share ONE provider request', async () => {
    const h = harness();
    const a = settle(h.sched.submit(job('SPY', 'QUANT_ON_DEMAND', 10, 20)));
    const b = settle(h.sched.submit(job('SPY', 'QUANT_SCHEDULED', 10, 20)));
    const c = settle(h.sched.submit(job('SPY', 'QUANT_ON_DEMAND', 10, 20)));
    await h.flush();
    expect(h.started).toHaveLength(1);
    h.started[0].resolve([1, 2, 3]); await h.flush();
    expect(await a).toMatchObject({ ok: true, v: [1, 2, 3] });
    expect(await b).toMatchObject({ ok: true, v: [1, 2, 3] });
    expect(await c).toMatchObject({ ok: true, v: [1, 2, 3] });
    expect(h.sched.getStats().counters.coalesced).toBe(2);
  });

  it('a queued backfill that a live caller also needs is PROMOTED to the live class (never waits behind other backfill)', async () => {
    const h = harness();
    void settle(h.sched.submit(job('BLOCK', 'QUANT_ON_DEMAND', 1, 2)));
    await h.flush();
    void settle(h.sched.submit(job('OTHER_BF', 'RESEARCH_BACKFILL', 7, 8)));
    void settle(h.sched.submit(job('SHARED', 'RESEARCH_BACKFILL', 3, 4)));
    expect(h.sched.getStats().depthByPriority).toEqual([0, 0, 0, 2]);
    void settle(h.sched.submit(job('SHARED', 'QUANT_ON_DEMAND', 3, 4)));
    expect(h.sched.getStats().depthByPriority).toEqual([0, 1, 0, 1]);
    expect(h.sched.getStats().counters.promoted).toBe(1);
    h.started[0].resolve([1]); await h.flush();
    expect(h.started[1].job.symbol).toBe('SHARED');
  });
});

describe('HistoricalRequestScheduler: bounded work', () => {
  it('stale low-priority work cannot grow without bound: queue bound rejects explicitly, expiry discards, depth never exceeds the bound', async () => {
    const h = harness({ maxQueued: { 0: 4, 1: 4, 2: 4, 3: 50 }, maxQueueWaitMs: { 0: 1_000, 1: 1_000, 2: 1_000, 3: 5_000 } });
    void settle(h.sched.submit(job('LIVE', 'QUANT_ON_DEMAND', 1, 2)));
    await h.flush();
    const results: Array<Promise<{ ok: boolean; e?: string }>> = [];
    for (let i = 0; i < 10_000; i++) results.push(settle(h.sched.submit(job(`BF${i}`, 'RESEARCH_BACKFILL', i, i + 1))) as any);
    await h.flush();
    expect(h.sched.getStats().depthByPriority[3]).toBeLessThanOrEqual(50);
    expect(h.sched.getStats().maxDepthObserved).toBeLessThanOrEqual(50 + 1);
    expect(h.sched.getStats().counters.droppedQueueFull).toBe(10_000 - 50);
    expect(h.timings.filter((r) => r.outcome === 'DROPPED_QUEUE_FULL')).toHaveLength(10_000 - 50);
    // time passes past the backfill expiry while the wire is busy: the queued backfill is discarded, not served stale
    h.advance(6_000);
    h.started[0].resolve([1]); await h.flush();
    expect(h.sched.getStats().depthTotal).toBe(0);
    expect(h.sched.getStats().counters.expired).toBe(50);
    expect(h.started).toHaveLength(1); // none of the stale backfill ever reached the provider
  });

  it('a live request that waited past its class expiry is discarded unserved (its caller already proceeded without it)', async () => {
    const h = harness();
    void settle(h.sched.submit(job('SLOW', 'QUANT_ON_DEMAND', 1, 2)));
    await h.flush();
    const late = settle(h.sched.submit(job('LATE', 'QUANT_SCHEDULED', 3, 4)));
    h.advance(17_000); // > ibkrHistQueueWaitMsP1 (16 s)
    h.started[0].resolve([1]); await h.flush();
    expect(await late).toMatchObject({ ok: false });
    expect(h.timings.find((r) => r.job.symbol === 'LATE')?.outcome).toBe('DROPPED_QUEUE_STALE');
    expect(h.started).toHaveLength(1);
  });

  it('a request whose only caller abandoned (AbortSignal) before service is discarded and never sent to IBKR', async () => {
    const h = harness();
    void settle(h.sched.submit(job('BLOCK', 'QUANT_ON_DEMAND', 1, 2)));
    await h.flush();
    const ac = new AbortController();
    const abandoned = settle(h.sched.submit(job('GONE', 'QUANT_SCHEDULED', 3, 4), { signal: ac.signal }));
    ac.abort();
    expect(await abandoned).toMatchObject({ ok: false });
    h.started[0].resolve([1]); await h.flush();
    expect(h.started.map((d) => d.job.symbol)).toEqual(['BLOCK']);
    expect(h.sched.getStats().counters.discardedAbandoned).toBe(1);
  });

  it('an already-running request nobody waits for is cancelled after the grace; a coalesced second caller keeps it alive', async () => {
    const h = harness();
    const ac1 = new AbortController(); const ac2 = new AbortController();
    const p1 = settle(h.sched.submit(job('RUN', 'QUANT_ON_DEMAND', 1, 2), { signal: ac1.signal }));
    const p2 = settle(h.sched.submit(job('RUN', 'QUANT_SCHEDULED', 1, 2), { signal: ac2.signal }));
    await h.flush();
    ac1.abort(); h.advance(5_000);
    expect(h.started[0].cancelled).toBe(false); // second caller still waits
    ac2.abort(); h.advance(2_500); await h.flush();
    expect(h.started[0].cancelled).toBe(true);
    expect(h.sched.getStats().counters.cancelledAbandoned).toBe(1);
    void p1; void p2;
  });

  it('a backfill preempted more than maxPreemptions times is rejected (retry later), not retried forever', async () => {
    const h = harness({ maxPreemptions: 2 });
    const bf = settle(h.sched.submit(job('BF', 'RESEARCH_BACKFILL', 1, 2)));
    await h.flush();
    for (let i = 0; i < 3; i++) {
      h.advance(1_000);
      void settle(h.sched.submit(job(`LIVE${i}`, 'QUANT_ON_DEMAND', 10 + i, 11 + i)));
      await h.flush();
      h.started[h.started.length - 1].resolve([1]); await h.flush(); // LIVE finishes, BF (re-queued) restarts
      if (i < 2) await h.flush();
    }
    const r = await bf;
    expect(r).toMatchObject({ ok: false });
    expect((r as any).e).toMatch(/PREEMPTED/);
  });

  it('exposes queue depth, oldest request age, and per-class counts for runtime proof', async () => {
    const h = harness();
    void settle(h.sched.submit(job('RUN', 'QUANT_ON_DEMAND', 1, 2)));
    await h.flush();
    void settle(h.sched.submit(job('A', 'QUANT_SCHEDULED', 3, 4)));
    void settle(h.sched.submit(job('B', 'RESEARCH_BACKFILL', 5, 6)));
    h.advance(3_000);
    const s = h.sched.getStats();
    expect(s.depthByPriority).toEqual([0, 1, 0, 1]);
    expect(s.runningIntent).toBe('QUANT_ON_DEMAND');
    expect(s.oldestQueuedAgeMs).toBe(3_000);
    expect(s.oldestQueuedAgeMsByPriority[1]).toBe(3_000);
  });
});
