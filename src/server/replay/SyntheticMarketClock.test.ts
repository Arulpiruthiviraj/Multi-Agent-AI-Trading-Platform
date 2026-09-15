import { describe, it, expect } from 'vitest';
import { SyntheticMarketClock } from './SyntheticMarketClock';
import { ReplayClock } from '../engines/backtest/ReplayClock';

/** Deterministic fake real-clock source - lets tests control "elapsed real time" exactly, instead
 *  of sleeping (real sleeps would make speed-multiplier assertions flaky/slow). */
function fakeRealClock(startMs: number) {
  let t = startMs;
  return {
    nowFn: () => t,
    advanceRealMs: (ms: number) => { t += ms; },
  };
}

describe('SyntheticMarketClock', () => {
  const START_SIM = new Date('2026-09-15T09:30:00.000Z').getTime();

  it('is a real ReplayClock (type-compatible with ActiveReplaySession.clock: ReplayClock)', () => {
    const clock = new SyntheticMarketClock(START_SIM);
    expect(clock).toBeInstanceOf(ReplayClock);
  });

  it('at 1x speed, simulated time advances 1:1 with real time', () => {
    const real = fakeRealClock(1000);
    const clock = new SyntheticMarketClock(START_SIM, { nowFn: real.nowFn, speedMultiplier: 1 });
    expect(clock.now()).toBe(START_SIM);
    real.advanceRealMs(5000);
    expect(clock.now()).toBe(START_SIM + 5000);
  });

  it('at Nx speed, simulated time advances N times faster than real time', () => {
    const real = fakeRealClock(0);
    const clock = new SyntheticMarketClock(START_SIM, { nowFn: real.nowFn, speedMultiplier: 300 });
    real.advanceRealMs(10_000); // 10 real seconds
    expect(clock.now()).toBe(START_SIM + 10_000 * 300); // 3000 simulated seconds = 50 simulated minutes
  });

  it('pause() freezes simulated time even as real time keeps moving', () => {
    const real = fakeRealClock(0);
    const clock = new SyntheticMarketClock(START_SIM, { nowFn: real.nowFn, speedMultiplier: 60 });
    real.advanceRealMs(1000);
    const atPause = clock.now();
    clock.pause();
    expect(clock.paused).toBe(true);
    real.advanceRealMs(60_000); // a full real minute passes while paused
    expect(clock.now()).toBe(atPause); // unchanged
  });

  it('resume() continues from exactly where it paused, not from a jumped anchor', () => {
    const real = fakeRealClock(0);
    const clock = new SyntheticMarketClock(START_SIM, { nowFn: real.nowFn, speedMultiplier: 10 });
    real.advanceRealMs(1000);
    clock.pause();
    const atPause = clock.now();
    real.advanceRealMs(5000); // time passes while paused - must not count
    clock.resume();
    expect(clock.paused).toBe(false);
    expect(clock.now()).toBe(atPause); // resumed exactly where it left off
    real.advanceRealMs(2000);
    expect(clock.now()).toBe(atPause + 2000 * 10);
  });

  it('setSpeedMultiplier() changes pace from now, without retroactively rewriting elapsed time', () => {
    const real = fakeRealClock(0);
    const clock = new SyntheticMarketClock(START_SIM, { nowFn: real.nowFn, speedMultiplier: 1 });
    real.advanceRealMs(1000); // simulated +1000ms so far at 1x
    const before = clock.now();
    expect(before).toBe(START_SIM + 1000);
    clock.setSpeedMultiplier(100);
    real.advanceRealMs(1000); // now at 100x
    expect(clock.now()).toBe(before + 1000 * 100);
  });

  it('setSpeedMultiplier() rejects non-positive values', () => {
    const clock = new SyntheticMarketClock(START_SIM);
    expect(() => clock.setSpeedMultiplier(0)).toThrow(/positive/);
    expect(() => clock.setSpeedMultiplier(-5)).toThrow(/positive/);
  });

  it('constructor rejects a non-positive initial speedMultiplier', () => {
    expect(() => new SyntheticMarketClock(START_SIM, { speedMultiplier: 0 })).toThrow(/positive/);
  });

  it('setTime() seeks forward and re-anchors real-time tracking from that point', () => {
    const real = fakeRealClock(0);
    const clock = new SyntheticMarketClock(START_SIM, { nowFn: real.nowFn, speedMultiplier: 1 });
    const marketOpen = START_SIM + 60_000; // jump 1 simulated minute ahead (e.g. skip to MARKET_OPEN)
    clock.setTime(marketOpen);
    expect(clock.now()).toBe(marketOpen);
    real.advanceRealMs(1000);
    expect(clock.now()).toBe(marketOpen + 1000);
  });

  it('reset() unconditionally re-anchors, unlike setTime() - the fix for real setup drift before a session loop starts', () => {
    const real = fakeRealClock(0);
    const clock = new SyntheticMarketClock(START_SIM, { nowFn: real.nowFn, speedMultiplier: 1 });
    real.advanceRealMs(2000); // simulates real setup work (bar generation, DB seeding, boot) elapsing before the loop begins
    expect(clock.now()).toBe(START_SIM + 2000); // drifted forward, as designed
    expect(() => clock.setTime(START_SIM)).toThrow(/cannot move backwards/); // setTime() correctly refuses
    clock.reset(START_SIM); // reset() does not
    expect(clock.now()).toBe(START_SIM);
    real.advanceRealMs(1000);
    expect(clock.now()).toBe(START_SIM + 1000); // and normal auto-drift resumes cleanly from the reset anchor
  });

  it('reset() also clears a paused state', () => {
    const clock = new SyntheticMarketClock(START_SIM);
    clock.pause();
    expect(clock.paused).toBe(true);
    clock.reset(START_SIM + 60_000);
    expect(clock.paused).toBe(false);
    expect(clock.now()).toBe(START_SIM + 60_000);
  });

  it('setTime()/advance() refuse to move simulated time backwards', () => {
    const real = fakeRealClock(0);
    const clock = new SyntheticMarketClock(START_SIM, { nowFn: real.nowFn });
    real.advanceRealMs(5000);
    expect(() => clock.setTime(START_SIM)).toThrow(/cannot move backwards/);
    expect(() => clock.advance(START_SIM)).toThrow(/cannot move backwards/);
  });

  it('advance() is an alias for setTime() (interface parity with ReplayClock callers)', () => {
    const real = fakeRealClock(0);
    const clock = new SyntheticMarketClock(START_SIM, { nowFn: real.nowFn, speedMultiplier: 1 });
    clock.advance(START_SIM + 120_000);
    expect(clock.now()).toBe(START_SIM + 120_000);
  });

  it('assertNotFuture() passes for a timestamp at or before live simulated time', () => {
    const clock = new SyntheticMarketClock(START_SIM, { speedMultiplier: 1 });
    expect(() => clock.assertNotFuture(START_SIM, 'test')).not.toThrow();
    expect(() => clock.assertNotFuture(START_SIM - 1000, 'test')).not.toThrow();
  });

  it('assertNotFuture() throws LOOK_AHEAD_BIAS_DETECTED for a timestamp after simulated time', () => {
    const real = fakeRealClock(0);
    const clock = new SyntheticMarketClock(START_SIM, { nowFn: real.nowFn, speedMultiplier: 1 });
    expect(() => clock.assertNotFuture(START_SIM + 10_000, 'synthetic news event')).toThrow(/LOOK_AHEAD_BIAS_DETECTED/);
  });

  it('simulatedTime and realTime getters expose both clocks distinctly', () => {
    const real = fakeRealClock(500);
    const clock = new SyntheticMarketClock(START_SIM, { nowFn: real.nowFn, speedMultiplier: 60 });
    expect(clock.realTime).toBe(500);
    real.advanceRealMs(1000);
    expect(clock.realTime).toBe(1500);
    expect(clock.simulatedTime).toBe(START_SIM + 1000 * 60);
  });
});
