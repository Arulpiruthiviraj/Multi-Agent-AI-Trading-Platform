import { describe, it, expect, vi, afterEach } from 'vitest';
import { awaitWithinDeadline } from './awaitWithinDeadline';

afterEach(() => vi.useRealTimers());

describe('awaitWithinDeadline', () => {
  it('returns the value when the work settles before the deadline', async () => {
    await expect(awaitWithinDeadline(Promise.resolve(7), 1000)).resolves.toEqual({ timedOut: false, value: 7 });
  });

  it('releases the caller at the deadline while the work keeps running (never cancelled)', async () => {
    vi.useFakeTimers();
    let finished = false;
    const work = new Promise<void>((r) => setTimeout(() => { finished = true; r(); }, 5000));
    const p = awaitWithinDeadline(work, 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toEqual({ timedOut: true });
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(finished).toBe(true); // underlying work completed on its own
  });

  it('a work promise that never settles cannot hang the caller', async () => {
    vi.useFakeTimers();
    const p = awaitWithinDeadline(new Promise<void>(() => { /* never */ }), 50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(p).resolves.toEqual({ timedOut: true });
  });

  it('a late rejection after the deadline is absorbed (no unhandled rejection)', async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const work = new Promise<void>((_, rej) => setTimeout(() => rej(new Error('late')), 500));
    const p = awaitWithinDeadline(work, 10);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toEqual({ timedOut: true });
    await vi.advanceTimersByTimeAsync(600);
    vi.useRealTimers();
    await new Promise((r) => setImmediate(r));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('an early rejection propagates to the caller (fail-open handling stays with the caller)', async () => {
    await expect(awaitWithinDeadline(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
  });
});
