import { describe, expect, it } from 'vitest';
import { evaluateSoakInvariants, type SoakBounds } from './SoakInvariants';
import type { ResourceSample } from './SyntheticSessionEngine';
import { loadRepoConfigJson } from '../../config/loadRepoConfigJson';

const bounds = loadRepoConfigJson<SoakBounds>('syntheticSoak.json');
const sample = (bar: number, o: Partial<ResourceSample> = {}): ResourceSample => ({
  atBarIndex: bar, heapUsedMb: 100, listenerTotal: 300, activeResources: {}, activeTimers: 40, nonTerminalOrders: 0, reservedNotionalUsd: 0, ...o,
});
const clean = { eventLoopMaxMs: 400, orphanPositions: 0, unexplainedViolations: [] as string[] };

describe('SoakInvariants', () => {
  it('a bounded, consistent session has no findings', () => {
    expect(evaluateSoakInvariants([sample(0), sample(10), sample(80, { heapUsedMb: 120, listenerTotal: 302 })], bounds, clean)).toEqual([]);
  });
  it('flags a listener leak even when the session made money', () => {
    const f = evaluateSoakInvariants([sample(10), sample(80, { listenerTotal: 300 + bounds.maxListenerGrowth + 500 })], bounds, clean);
    expect(f.map((x) => x.code)).toEqual(['LISTENER_GROWTH']);
  });
  it('flags stale capital reservations, open orders at the end, timer/heap growth, loop stalls, orphans and missing samples', () => {
    const f = evaluateSoakInvariants(
      [sample(10), sample(80, { reservedNotionalUsd: 2700, nonTerminalOrders: 2, activeTimers: 40 + bounds.maxTimerGrowth + 1, heapUsedMb: 100 + bounds.maxHeapGrowthMb + 1 })],
      bounds, { eventLoopMaxMs: bounds.maxEventLoopMaxMs + 1, orphanPositions: 1, unexplainedViolations: ['X'] },
    );
    expect(f.map((x) => x.code).sort()).toEqual(['CAPITAL_RESERVATION_LEAK', 'EVENT_LOOP_STALL', 'HEAP_GROWTH', 'OPEN_ORDERS_AT_END', 'ORPHAN_POSITION', 'TIMELINE_INVARIANT', 'TIMER_GROWTH']);
    expect(evaluateSoakInvariants([sample(10)], bounds, clean)[0].code).toBe('NO_RESOURCE_SAMPLES');
  });
});
