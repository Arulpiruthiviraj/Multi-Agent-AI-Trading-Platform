import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { evaluateSessionLifecycle, sessionLifecycleWorker } from './SessionLifecycle';
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

describe('sessionLifecycleWorker (stateful, event-emitting)', () => {
  let emitSpy: ReturnType<typeof vi.spyOn>;

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

  it('start()/stop() do not throw and start() is idempotent', () => {
    expect(() => sessionLifecycleWorker.start()).not.toThrow();
    expect(() => sessionLifecycleWorker.start()).not.toThrow();
    expect(() => sessionLifecycleWorker.stop()).not.toThrow();
    expect(() => sessionLifecycleWorker.stop()).not.toThrow();
  });

  it('getSnapshot() reflects the most recent evaluate() call', () => {
    sessionLifecycleWorker.evaluate(etOnWednesday(10, 0));
    expect(sessionLifecycleWorker.getSnapshot()).toMatchObject({ marketSession: 'REGULAR', appState: 'INTRADAY' });
  });
});
