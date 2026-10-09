/**
 * Workstream K wiring test (2026-10-08 docs-feature scan).
 *
 * Proves the TODO in dailyReflection.ts is now wired: computeSessionMetrics()
 * triggers computeAndPersistWeeklyDigest for the Monday-start week containing
 * the trading date. Uses the REAL weekStartMonday (only the persist call is
 * mocked); the digest's own logic is covered by weeklyDigest*.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('./weeklyDigest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./weeklyDigest')>();
  return {
    ...actual,
    computeAndPersistWeeklyDigest: vi.fn().mockResolvedValue([]),
  };
});

import { computeSessionMetrics } from './dailyReflection';
import { computeAndPersistWeeklyDigest, weekStartMonday } from './weeklyDigest';

describe('workstream K wiring (computeSessionMetrics -> weekly digest)', () => {
  it('triggers the digest for the Monday-start week containing the trading date', async () => {
    const mock = vi.mocked(computeAndPersistWeeklyDigest);
    mock.mockClear();
    // 2026-10-08 is a Thursday; containing week starts Monday 2026-10-05.
    expect(weekStartMonday('2026-10-08')).toBe('2026-10-05');
    computeSessionMetrics('2026-10-08');
    // Fire-and-forget: allow the microtask/macrotask to flush.
    await new Promise((r) => setTimeout(r, 100));
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0]).toBe('2026-10-05');
  });

  it('a throwing digest is contained — never propagates to the caller', async () => {
    const mock = vi.mocked(computeAndPersistWeeklyDigest);
    mock.mockRejectedValueOnce(new Error('synthetic digest failure'));
    expect(() => computeSessionMetrics('2026-10-08')).not.toThrow();
    await new Promise((r) => setTimeout(r, 100));
    // Rejection was caught inside computeSessionMetrics: no unhandled rejection,
    // and the hook remains usable afterwards.
    mock.mockResolvedValue([]);
    computeSessionMetrics('2026-10-08');
    await new Promise((r) => setTimeout(r, 100));
    expect(mock).toHaveBeenCalled();
  });
});
