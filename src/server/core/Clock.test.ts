import { describe, it, expect } from 'vitest';
import { LiveClock, type Clock } from './Clock';
import { ReplayClock } from '../engines/backtest/ReplayClock';

describe('Clock (Institutional Architecture Proposal, Phase A3)', () => {
  it('LiveClock.now() returns the real current time', () => {
    const clock: Clock = new LiveClock();
    const before = Date.now();
    const got = clock.now();
    const after = Date.now();
    expect(got).toBeGreaterThanOrEqual(before);
    expect(got).toBeLessThanOrEqual(after);
  });

  it('ReplayClock structurally satisfies Clock and is usable anywhere a Clock is expected', () => {
    const startMs = Date.parse('2026-01-01T00:00:00Z');
    const clock: Clock = new ReplayClock(startMs);
    expect(clock.now()).toBe(startMs);
  });

  it('a function written against the Clock interface works identically with either real implementation', () => {
    function readTwice(clock: Clock): [number, number] {
      return [clock.now(), clock.now()];
    }
    const liveReads = readTwice(new LiveClock());
    expect(liveReads[0]).toBeLessThanOrEqual(liveReads[1]); // real time never moves backwards

    const replayStartMs = Date.parse('2026-06-15T09:30:00Z');
    const replayReads = readTwice(new ReplayClock(replayStartMs));
    expect(replayReads).toEqual([replayStartMs, replayStartMs]); // simulated time is frozen until advance()
  });

  it('ReplayClock still enforces its real look-ahead-bias guard unchanged by this interface addition', () => {
    const clock = new ReplayClock(Date.parse('2026-01-01T00:00:00Z'));
    expect(() => clock.assertNotFuture(Date.parse('2026-01-02T00:00:00Z'), 'test bar')).toThrow(/LOOK_AHEAD_BIAS_DETECTED/);
    clock.advance(Date.parse('2026-01-02T00:00:00Z'));
    expect(() => clock.assertNotFuture(Date.parse('2026-01-02T00:00:00Z'), 'test bar')).not.toThrow();
  });
});
