import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getMobileMissionSnapshot,
  patchMobileMissionSnapshot,
  mergeMobileMissionSnapshot,
  subscribeMobileMissionSnapshot,
  resetMobileMissionSnapshot,
} from './mobileMissionStore';

/**
 * mobileMissionStore tests (2026-10-06). The snapshot store drives Mobile
 * Mission Control — patch/merge/subscribe/reset must behave predictably,
 * and listeners must fire exactly once per mutation.
 */

afterEach(() => {
  resetMobileMissionSnapshot();
});

describe('mobileMissionStore', () => {
  it('patchMobileMissionSnapshot merges fields without dropping the rest', () => {
    const before = getMobileMissionSnapshot();
    patchMobileMissionSnapshot({ tradingState: 'TRADING_PAUSED' } as never);
    const after = getMobileMissionSnapshot();
    expect(after.tradingState).toBe('TRADING_PAUSED');
    // unrelated fields survive the patch
    for (const key of Object.keys(before)) {
      if (key === 'tradingState') continue;
      expect(after[key as keyof typeof after]).toEqual(before[key as keyof typeof before]);
    }
  });

  it('mergeMobileMissionSnapshot applies the updater against the previous snapshot', () => {
    mergeMobileMissionSnapshot((prev) => ({ gates: [...(prev.gates ?? []), { id: 'g1' } as never] }));
    expect(getMobileMissionSnapshot().gates).toHaveLength(1);
  });

  it('subscribe notifies listeners on patch and merge, and unsubscribe stops notifications', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMobileMissionSnapshot(listener);
    patchMobileMissionSnapshot({});
    expect(listener).toHaveBeenCalledTimes(1);
    mergeMobileMissionSnapshot(() => ({}));
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    patchMobileMissionSnapshot({});
    expect(listener).toHaveBeenCalledTimes(2); // no more calls after unsubscribe
  });

  it('resetMobileMissionSnapshot restores the initial snapshot and notifies', () => {
    const listener = vi.fn();
    subscribeMobileMissionSnapshot(listener);
    const initial = getMobileMissionSnapshot();
    patchMobileMissionSnapshot({ tradingState: 'EMERGENCY_STOP' } as never);
    expect(getMobileMissionSnapshot().tradingState).toBe('EMERGENCY_STOP');
    resetMobileMissionSnapshot();
    expect(getMobileMissionSnapshot()).toEqual(initial);
    expect(listener).toHaveBeenCalled();
  });
});
