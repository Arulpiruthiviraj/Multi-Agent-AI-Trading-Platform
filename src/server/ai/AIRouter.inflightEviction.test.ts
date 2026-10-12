import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * 2026-10-12 (L3): the bounded routeTask() in-flight map's cap eviction used to evict the
 * map's oldest entry regardless of state, so a still-running (unsettled) execution could lose
 * its dedup entry and a duplicate provider call would start. Eviction must prefer the oldest
 * SETTLED entry, falling back to the oldest unsettled entry only when every entry is
 * unsettled. The cap itself (aiCallGovernor.aiStateCacheMaxEntries) is unchanged - it is read
 * from the same config production loads, never hardcoded here.
 */
describe('AIRouter routeTask in-flight cap eviction (L3)', () => {
  let tmpDbPath: string;
  let router: any;
  let cap: number;

  function deferred() {
    let resolve!: (v: any) => void;
    let reject!: (e: any) => void;
    const promise = new Promise<any>((res, rej) => { resolve = res; reject = rej; });
    // Never an unhandled rejection: the router attaches its own catch, and these deferreds
    // are only ever resolved in these tests.
    promise.catch(() => undefined);
    return { promise, resolve, reject };
  }

  function track(key: string, d: { promise: Promise<any> }) {
    router.trackRouteTaskInFlight(key, d.promise);
  }

  async function settle(d: { promise: Promise<any>; resolve: (v: any) => void }) {
    d.resolve({ ok: true } as any);
    // Let trackRouteTaskInFlight's .then() settlement handlers run so entry.settled flips.
    await new Promise((r) => setImmediate(r));
  }

  function keys(): string[] {
    return router.__routeTaskInFlightKeysForTests().map((e: { key: string }) => e.key);
  }

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_airouter_evict_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    const { AIRouter } = await import('./AIRouter');
    const { aiCallGovernor } = await import('../config/aiCallGovernor');
    router = AIRouter.getInstance();
    cap = aiCallGovernor.aiStateCacheMaxEntries;
    expect(cap).toBeGreaterThan(10); // sanity: the test below fills to cap
  });

  afterAll(async () => {
    const { sqliteDb } = await import('../db');
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  beforeEach(() => {
    router.clearProviders(); // also clears routeTaskInFlight - each test starts empty
  });

  it('evicts the oldest SETTLED entry first, preserving unsettled entries', async () => {
    // The oldest entry overall is UNSETTLED - the pre-fix code would have evicted exactly this.
    const oldestUnsettled = deferred();
    track('unsettled-oldest', oldestUnsettled);

    const settledOnes: Array<ReturnType<typeof deferred>> = [];
    for (let i = 0; i < cap - 2; i++) {
      const d = deferred();
      track(`settled-${i}`, d);
      settledOnes.push(d);
    }
    for (const d of settledOnes) await settle(d);
    const lastSettled = deferred();
    track('settled-last', lastSettled);
    await settle(lastSettled);
    expect(router.__routeTaskInFlightSizeForTests()).toBe(cap);

    // One more insert forces exactly one eviction.
    track('newcomer', deferred());

    const after = keys();
    expect(after).toHaveLength(cap);
    expect(after).not.toContain('settled-0'); // oldest SETTLED entry evicted
    expect(after).toContain('unsettled-oldest'); // unsettled preserved despite being oldest overall
    expect(after).toContain('settled-1');
    expect(after).toContain('settled-last');
    expect(after).toContain('newcomer');
  });

  it('evicts the oldest unsettled entry when every entry is unsettled', async () => {
    for (let i = 0; i < cap; i++) {
      track(`pending-${i}`, deferred()); // never settled
    }
    expect(router.__routeTaskInFlightSizeForTests()).toBe(cap);

    track('newcomer', deferred());

    const after = keys();
    expect(after).toHaveLength(cap);
    expect(after).not.toContain('pending-0'); // oldest unsettled evicted as the only option
    expect(after).toContain('pending-1');
    expect(after).toContain(`pending-${cap - 1}`);
    expect(after).toContain('newcomer');
  });

  it('a newly-settled entry becomes eviction-eligible on the next insert past cap', async () => {
    // Fill to cap with all-unsettled entries, then settle the newest one: the next insert
    // must evict that settled entry, not the oldest unsettled one.
    const all: Array<ReturnType<typeof deferred>> = [];
    for (let i = 0; i < cap; i++) {
      const d = deferred();
      track(`pending-${i}`, d);
      all.push(d);
    }
    await settle(all[cap - 1]); // only the newest entry settles

    track('newcomer', deferred());

    const after = keys();
    expect(after).toHaveLength(cap);
    expect(after).not.toContain(`pending-${cap - 1}`); // the settled entry evicted...
    expect(after).toContain('pending-0'); // ...instead of the oldest unsettled one
    expect(after).toContain('newcomer');
  });
});
