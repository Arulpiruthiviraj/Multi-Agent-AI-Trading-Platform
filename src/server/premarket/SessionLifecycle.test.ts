import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { evaluateSessionLifecycle, sessionLifecycleWorker, getRefinedSnapshot } from './SessionLifecycle';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';

/** All times below are constructed as UTC instants that land at the stated America/New_York
 *  clock time on a known weekday, so the test is not sensitive to the host machine's own
 *  timezone. 2026-08-26 is a Wednesday; EDT is UTC-4 that week. */
function etOnWednesday(hh: number, mm: number): Date {
  return new Date(`2026-08-26T${String(hh + 4).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`);
}
function etOnSaturday(hh: number, mm: number): Date {
  // 2026-08-29 is a Saturday.
  return new Date(`2026-08-29T${String(hh + 4).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`);
}

describe('evaluateSessionLifecycle (pure, boot-classification)', () => {
  it('classifies a weekday pre-market time as PRE_MARKET / RESEARCHING', () => {
    const snap = evaluateSessionLifecycle(etOnWednesday(8, 0));
    expect(snap.marketSession).toBe('PRE_MARKET');
    expect(snap.appState).toBe('RESEARCHING');
    expect(snap.tradingDate).toBe('2026-08-26');
  });

  it('classifies a weekday regular-session time as REGULAR / INTRADAY', () => {
    const snap = evaluateSessionLifecycle(etOnWednesday(10, 15));
    expect(snap.marketSession).toBe('REGULAR');
    expect(snap.appState).toBe('INTRADAY');
  });

  it('classifies a weekday after-hours time as AFTER_HOURS / CLOSE_REVIEW', () => {
    const snap = evaluateSessionLifecycle(etOnWednesday(17, 0));
    expect(snap.marketSession).toBe('AFTER_HOURS');
    expect(snap.appState).toBe('CLOSE_REVIEW');
  });

  it('classifies a weekday overnight time (outside 04:00-20:00 ET) as CLOSED / IDLE', () => {
    const snap = evaluateSessionLifecycle(etOnWednesday(2, 0));
    expect(snap.marketSession).toBe('CLOSED');
    expect(snap.appState).toBe('IDLE');
  });

  it('classifies a weekend time as CLOSED / IDLE regardless of hour', () => {
    const snap = evaluateSessionLifecycle(etOnSaturday(10, 0));
    expect(snap.marketSession).toBe('CLOSED');
    expect(snap.appState).toBe('IDLE');
  });
});

describe('evaluateSessionLifecycle — SessionContext fields', () => {
  it('PRE_MARKET: isExtendedHours true, isTradingDay true, minutesToOpen positive, minutesSinceOpen negative', () => {
    const snap = evaluateSessionLifecycle(etOnWednesday(8, 0)); // 08:00 ET, open is 09:30 -> 90 min to open
    expect(snap.isExtendedHours).toBe(true);
    expect(snap.isTradingDay).toBe(true);
    expect(snap.minutesToOpen).toBe(90);
    expect(snap.minutesSinceOpen).toBe(-90);
    expect(snap.minutesToClose).toBe(480); // 16:00 - 08:00 = 480
    expect(snap.sessionId).toBe('argus-session-2026-08-26');
  });

  it('REGULAR: isExtendedHours false, minutesSinceOpen positive', () => {
    const snap = evaluateSessionLifecycle(etOnWednesday(10, 15)); // 45 min after 09:30 open
    expect(snap.isExtendedHours).toBe(false);
    expect(snap.isTradingDay).toBe(true);
    expect(snap.minutesSinceOpen).toBe(45);
    expect(snap.minutesToOpen).toBe(-45);
  });

  it('weekend: isTradingDay false, all minute fields null', () => {
    const snap = evaluateSessionLifecycle(etOnSaturday(10, 0));
    expect(snap.isTradingDay).toBe(false);
    expect(snap.isExtendedHours).toBe(false);
    expect(snap.minutesToOpen).toBeNull();
    expect(snap.minutesSinceOpen).toBeNull();
    expect(snap.minutesToClose).toBeNull();
  });

  it('sessionId is stable across multiple evaluations on the same trading day', () => {
    const a = evaluateSessionLifecycle(etOnWednesday(8, 0));
    const b = evaluateSessionLifecycle(etOnWednesday(14, 0));
    expect(a.sessionId).toBe(b.sessionId);
  });
});

describe('sessionLifecycleWorker (stateful, event-emitting)', () => {
  let emitSpy: ReturnType<typeof vi.spyOn>;
  let tmpDbPath: string;
  let sqliteDb: any;
  let db: any;
  let schema: any;

  beforeAll(async () => {
    // Phase 4J: start()/stop() below now dynamically imports ../db to persist/hydrate lifecycle
    // snapshots. Isolate this file to a temp DB so it never opens (or writes into) the real
    // data/argus.db - matching the convention every other DB-touching test file uses.
    tmpDbPath = path.join(os.tmpdir(), `argus_sessionlifecycle_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  beforeEach(() => {
    sessionLifecycleWorker.resetForTests();
    emitSpy = vi.spyOn(eventBus, 'emit');
  });

  afterEach(() => {
    sessionLifecycleWorker.resetForTests();
    emitSpy.mockRestore();
  });

  it('emits PREMARKET_SESSION_STARTED exactly once when entering PRE_MARKET for a given trading day', () => {
    sessionLifecycleWorker.evaluate(etOnWednesday(8, 0));
    sessionLifecycleWorker.evaluate(etOnWednesday(8, 5));
    sessionLifecycleWorker.evaluate(etOnWednesday(8, 10));

    const premarketFires = emitSpy.mock.calls.filter(([event]) => event === EVENTS.PREMARKET_SESSION_STARTED);
    expect(premarketFires.length).toBe(1);
    expect(premarketFires[0][1]).toMatchObject({ tradingDate: '2026-08-26' });
  });

  it('emits SESSION_LIFECYCLE_STATE_CHANGED on a real transition, not on a same-state re-evaluation', () => {
    sessionLifecycleWorker.evaluate(etOnWednesday(8, 0)); // boot -> PRE_MARKET/RESEARCHING (1st change, from null)
    emitSpy.mockClear();

    sessionLifecycleWorker.evaluate(etOnWednesday(8, 5)); // still PRE_MARKET/RESEARCHING - no change
    expect(emitSpy.mock.calls.some(([event]) => event === EVENTS.SESSION_LIFECYCLE_STATE_CHANGED)).toBe(false);

    sessionLifecycleWorker.evaluate(etOnWednesday(10, 0)); // -> REGULAR/INTRADAY - real change
    const changeFires = emitSpy.mock.calls.filter(([event]) => event === EVENTS.SESSION_LIFECYCLE_STATE_CHANGED);
    expect(changeFires.length).toBe(1);
    expect(changeFires[0][1]).toMatchObject({
      to: { marketPhase: 'REGULAR', appState: 'INTRADAY' },
    });
  });

  it('does not refire PREMARKET_SESSION_STARTED for the same trading day after a session-state round-trip', () => {
    sessionLifecycleWorker.evaluate(etOnWednesday(8, 0)); // PRE_MARKET
    sessionLifecycleWorker.evaluate(etOnWednesday(10, 0)); // REGULAR
    emitSpy.mockClear();
    sessionLifecycleWorker.evaluate(etOnWednesday(8, 30)); // hypothetically back to PRE_MARKET math, same day
    expect(emitSpy.mock.calls.some(([event]) => event === EVENTS.PREMARKET_SESSION_STARTED)).toBe(false);
  });

  it('start()/stop() do not throw, start() is idempotent, and stop() clears the interval before the test ends', async () => {
    await expect(sessionLifecycleWorker.start()).resolves.toBeUndefined();
    await expect(sessionLifecycleWorker.start()).resolves.toBeUndefined(); // idempotent - second call is a same-tick no-op
    expect(() => sessionLifecycleWorker.stop()).not.toThrow();
    expect(() => sessionLifecycleWorker.stop()).not.toThrow();
  });

  it('getSnapshot() reflects the most recent evaluate() call', () => {
    sessionLifecycleWorker.evaluate(etOnWednesday(10, 0));
    expect(sessionLifecycleWorker.getSnapshot()).toMatchObject({ marketSession: 'REGULAR', appState: 'INTRADAY' });
  });

  describe('getRefinedSnapshot — real TradePlan-aware appState refinement', () => {
    beforeEach(async () => {
      await db.delete(schema.tradePlans);
    });
    afterEach(async () => {
      await db.delete(schema.tradePlans);
    });

    function baseTradePlanRow(overrides: Partial<typeof schema.tradePlans.$inferInsert> = {}) {
      return {
        id: `plan-${Math.random()}`,
        symbol: 'AAPL',
        planDate: '2026-08-26',
        setupType: 'PRIMARY',
        direction: 'BUY',
        thesis: 'test thesis',
        catalysts: JSON.stringify([]),
        entryZoneLow: 100, entryZoneHigh: 101,
        invalidationLevel: 98,
        targetConcept: 'test target',
        confidence: 0.8, evidenceQuality: 1,
        rankAtCreation: 1,
        componentScoresJson: '{}',
        status: 'READY',
        createdAt: new Date().toISOString(),
        validUntil: '2026-08-26T20:00:00.000Z',
        ...overrides,
      };
    }

    it('PRE_MARKET with no existing plans -> PLAN_BUILDING', async () => {
      const snap = evaluateSessionLifecycle(etOnWednesday(8, 0));
      const refined = await getRefinedSnapshot(snap);
      expect(refined.appState).toBe('PLAN_BUILDING');
      expect(refined.marketSession).toBe('PRE_MARKET'); // unrefined fields pass through unchanged
    });

    it('PRE_MARKET with existing plans -> PLAN_READY', async () => {
      await db.insert(schema.tradePlans).values(baseTradePlanRow());
      const snap = evaluateSessionLifecycle(etOnWednesday(8, 0));
      const refined = await getRefinedSnapshot(snap);
      expect(refined.appState).toBe('PLAN_READY');
    });

    it('REGULAR with a plan still READY/VALID/REVALIDATING -> OPEN_REVALIDATION', async () => {
      await db.insert(schema.tradePlans).values(baseTradePlanRow({ status: 'VALID' }));
      const snap = evaluateSessionLifecycle(etOnWednesday(10, 0));
      const refined = await getRefinedSnapshot(snap);
      expect(refined.appState).toBe('OPEN_REVALIDATION');
    });

    it('REGULAR with only terminal-status plans -> unrefined (INTRADAY)', async () => {
      await db.insert(schema.tradePlans).values(baseTradePlanRow({ status: 'INVALIDATED' }));
      const snap = evaluateSessionLifecycle(etOnWednesday(10, 0));
      const refined = await getRefinedSnapshot(snap);
      expect(refined.appState).toBe('INTRADAY');
    });

    it('CLOSED/AFTER_HOURS pass through unrefined regardless of plan state', async () => {
      await db.insert(schema.tradePlans).values(baseTradePlanRow());
      const snap = evaluateSessionLifecycle(etOnWednesday(2, 0)); // CLOSED
      const refined = await getRefinedSnapshot(snap);
      expect(refined.appState).toBe('IDLE');
    });

    it('never mutates sessionLifecycleWorker\'s own current/event-emission state', async () => {
      sessionLifecycleWorker.evaluate(etOnWednesday(8, 0));
      const before = sessionLifecycleWorker.getSnapshot();
      await getRefinedSnapshot(before);
      expect(sessionLifecycleWorker.getSnapshot()).toEqual(before); // untouched by the refinement call
    });
  });

  describe('Phase 4J: persistence across restart', () => {
    beforeEach(async () => {
      // Guarantee a clean table regardless of what any earlier test (in or outside this nested
      // block, e.g. the plain start()/stop() smoke test above) already persisted.
      await db.delete(schema.sessionLifecycleSnapshots);
    });

    afterEach(async () => {
      await db.delete(schema.sessionLifecycleSnapshots);
    });

    it('start() persists a real snapshot row that a later query can read back', async () => {
      const before = await db.select().from(schema.sessionLifecycleSnapshots);
      expect(before.length).toBe(0);

      await sessionLifecycleWorker.start();
      sessionLifecycleWorker.stop();
      // persistSnapshot() is fire-and-forget (void), so give its microtask/IO a tick to land.
      await new Promise((r) => setTimeout(r, 50));

      const rows = await db.select().from(schema.sessionLifecycleSnapshots);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0].marketSession).toBeTruthy();
      expect(rows[0].appState).toBeTruthy();
    });

    it('restores a real prior same-day state on the next start(), instead of emitting from: null', async () => {
      const today = evaluateSessionLifecycle(etOnWednesday(8, 0)).tradingDate;
      await db.insert(schema.sessionLifecycleSnapshots).values({
        tradingDate: today,
        marketSession: 'PRE_MARKET',
        appState: 'RESEARCHING',
        premarketFiredForDate: today,
        evaluatedAt: etOnWednesday(8, 0).toISOString(),
        createdAt: etOnWednesday(8, 0).toISOString(),
      });

      await sessionLifecycleWorker.start(etOnWednesday(8, 1)); // still PRE_MARKET - no spurious change on boot
      emitSpy.mockClear();

      // Real transition to REGULAR - since hydration restored PRE_MARKET/RESEARCHING as the
      // known prior state, this must report a real `from`, not from: null.
      sessionLifecycleWorker.evaluate(etOnWednesday(10, 0));
      const changeFires = emitSpy.mock.calls.filter(([event]) => event === EVENTS.SESSION_LIFECYCLE_STATE_CHANGED);
      expect(changeFires.length).toBe(1);
      expect(changeFires[0][1]).toMatchObject({
        from: { marketPhase: 'PRE_MARKET', appState: 'RESEARCHING' },
        to: { marketPhase: 'REGULAR', appState: 'INTRADAY' },
      });

      // Because premarketFiredForDate was already restored for today, PRE_MARKET must not refire.
      sessionLifecycleWorker.evaluate(etOnWednesday(8, 30));
      expect(emitSpy.mock.calls.some(([event]) => event === EVENTS.PREMARKET_SESSION_STARTED)).toBe(false);

      sessionLifecycleWorker.stop();
    });

    it('ignores a persisted row from a prior trading day (honest from: null on a real new day)', async () => {
      await db.insert(schema.sessionLifecycleSnapshots).values({
        tradingDate: '2020-01-01',
        marketSession: 'REGULAR',
        appState: 'INTRADAY',
        premarketFiredForDate: '2020-01-01',
        evaluatedAt: '2020-01-01T14:00:00.000Z',
        createdAt: '2020-01-01T14:00:00.000Z',
      });

      // Hydration must find no same-day (2026-08-26) row and leave `current` null, so start()'s
      // own first evaluate() reports the honest from: null transition (not the stale 2020 row).
      await sessionLifecycleWorker.start(etOnWednesday(8, 0));

      const changeFires = emitSpy.mock.calls.filter(([event]) => event === EVENTS.SESSION_LIFECYCLE_STATE_CHANGED);
      expect(changeFires.length).toBe(1);
      expect(changeFires[0][1]).toMatchObject({ from: null, to: { marketPhase: 'PRE_MARKET', appState: 'RESEARCHING' } });

      sessionLifecycleWorker.stop();
    });
  });
});
