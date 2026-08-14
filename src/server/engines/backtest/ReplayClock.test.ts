import { describe, it, expect } from 'vitest';
import { ReplayClock } from './ReplayClock';

/**
 * Real, previously-missing test coverage for the single most safety-critical correctness
 * property in the backtest engine: a strategy must never see a bar/event from after the
 * simulated "current" moment. Flagged in FINAL_ANALYSIS.md (15.9/15.22 #12) as a real guard with
 * zero test coverage - this closes that gap directly against the actual class, not a mock of it.
 */
describe('ReplayClock', () => {
  it('starts at the given time', () => {
    const clock = new ReplayClock(1000);
    expect(clock.now()).toBe(1000);
  });

  it('advances forward', () => {
    const clock = new ReplayClock(1000);
    clock.advance(2000);
    expect(clock.now()).toBe(2000);
  });

  it('allows advancing to the exact same timestamp (a no-op, not an error)', () => {
    const clock = new ReplayClock(1000);
    expect(() => clock.advance(1000)).not.toThrow();
    expect(clock.now()).toBe(1000);
  });

  it('refuses to move backwards in time', () => {
    const clock = new ReplayClock(2000);
    expect(() => clock.advance(1000)).toThrow(/cannot move backwards/i);
    expect(clock.now()).toBe(2000); // unchanged after the rejected attempt
  });

  it('detects real look-ahead bias: a future timestamp is rejected with LOOK_AHEAD_BIAS_DETECTED', () => {
    const clock = new ReplayClock(1000);
    expect(() => clock.assertNotFuture(1001, 'bar')).toThrow(/LOOK_AHEAD_BIAS_DETECTED/);
  });

  it('includes the caller-supplied context in the look-ahead error, for a traceable failure', () => {
    const clock = new ReplayClock(1000);
    expect(() => clock.assertNotFuture(5000, 'AAPL daily bar')).toThrow(/AAPL daily bar/);
  });

  it('allows a timestamp exactly at the current simulated time (the boundary, not past it)', () => {
    const clock = new ReplayClock(1000);
    expect(() => clock.assertNotFuture(1000, 'bar')).not.toThrow();
  });

  it('allows any timestamp strictly in the past', () => {
    const clock = new ReplayClock(5000);
    expect(() => clock.assertNotFuture(1000, 'bar')).not.toThrow();
  });

  it('a realistic backtest loop: advancing through bars one at a time never trips the guard on the bar being processed, but does trip it if a bar from ahead in the sequence is checked early', () => {
    const bars = [1000, 2000, 3000, 4000, 5000];
    const clock = new ReplayClock(bars[0]);

    for (const barTs of bars) {
      clock.advance(barTs);
      expect(() => clock.assertNotFuture(barTs, `bar@${barTs}`)).not.toThrow();
    }

    // Simulates the real bug class this guard exists to catch: a strategy peeking at a bar from
    // later in the sequence before the clock has actually reached it.
    const midClock = new ReplayClock(bars[1]);
    expect(() => midClock.assertNotFuture(bars[3], `bar@${bars[3]}`)).toThrow(/LOOK_AHEAD_BIAS_DETECTED/);
  });
});
