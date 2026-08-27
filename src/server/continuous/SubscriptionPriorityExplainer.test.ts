import { describe, it, expect } from 'vitest';
import {
  explainSnapshotHotSwapDecisions,
  computeCapacitySnapshot,
  detectStarvedCandidates,
} from './SubscriptionPriorityExplainer';
import type { SnapshotCandidate } from './SnapshotScanner';

function cand(symbol: string, momentumScore: number): SnapshotCandidate {
  return { symbol, momentumScore, intradayPctChange: 0, relativeVolume: 0, rangeExpansion: 0 };
}

describe('explainSnapshotHotSwapDecisions', () => {
  it('marks an already-active candidate ALREADY_ACTIVE', () => {
    const decisions = explainSnapshotHotSwapDecisions({
      top: [cand('AAPL', 0.9)],
      active: new Set(['AAPL']),
      activeDynamic: ['AAPL'],
      emptySlots: 0,
      maxSwaps: 1,
      scoreEdge: 0.1,
      scoreOf: () => 0.5,
    });
    expect(decisions[0].action).toBe('ALREADY_ACTIVE');
  });

  it('promotes a new candidate to fill an empty slot', () => {
    const decisions = explainSnapshotHotSwapDecisions({
      top: [cand('NEW', 0.5)],
      active: new Set(),
      activeDynamic: [],
      emptySlots: 3,
      maxSwaps: 3,
      scoreEdge: 0.1,
      scoreOf: () => 0,
    });
    expect(decisions[0].action).toBe('PROMOTED');
    expect(decisions[0].reason).toMatch(/empty streaming slot/i);
  });

  it('promotes a candidate that beats the weakest active dynamic symbol by more than the hysteresis edge, and records what it displaces', () => {
    const decisions = explainSnapshotHotSwapDecisions({
      top: [cand('STRONG', 0.9)],
      active: new Set(['WEAK']),
      activeDynamic: ['WEAK'],
      emptySlots: 0,
      maxSwaps: 1,
      scoreEdge: 0.1,
      scoreOf: (s) => (s === 'WEAK' ? 0.2 : 0),
    });
    expect(decisions[0].action).toBe('PROMOTED');
    expect(decisions[0].displaces).toBe('WEAK');
  });

  it('does NOT promote a candidate that fails to beat the weakest by the hysteresis edge - explains why (anti-thrashing)', () => {
    const decisions = explainSnapshotHotSwapDecisions({
      top: [cand('MARGINAL', 0.25)],
      active: new Set(['WEAK']),
      activeDynamic: ['WEAK'],
      emptySlots: 0,
      maxSwaps: 1,
      scoreEdge: 0.1,
      scoreOf: (s) => (s === 'WEAK' ? 0.2 : 0),
    });
    expect(decisions[0].action).toBe('NOT_PROMOTED');
    expect(decisions[0].reason).toMatch(/hysteresis edge/i);
  });

  it('reports NOT_PROMOTED once the per-cycle swap cap is reached, even for a genuinely strong candidate', () => {
    const decisions = explainSnapshotHotSwapDecisions({
      top: [cand('FIRST', 0.9), cand('SECOND', 0.95)],
      active: new Set(['WEAK1', 'WEAK2']),
      activeDynamic: ['WEAK1', 'WEAK2'],
      emptySlots: 0,
      maxSwaps: 1, // matches momentumHotSwapSlotsPerCycle = 1 in production
      scoreEdge: 0.1,
      scoreOf: () => 0.1,
    });
    expect(decisions[0].action).toBe('PROMOTED');
    expect(decisions[1].action).toBe('NOT_PROMOTED');
    expect(decisions[1].reason).toMatch(/cap reached/i);
  });

  it('reports NOT_PROMOTED with a clear reason when there is no capacity and no dynamic symbol to displace', () => {
    const decisions = explainSnapshotHotSwapDecisions({
      top: [cand('NEW', 0.9)],
      active: new Set(['CORE1']), // all active symbols are core/protected, none dynamic
      activeDynamic: [],
      emptySlots: 0,
      maxSwaps: 1,
      scoreEdge: 0.1,
      scoreOf: () => 0,
    });
    expect(decisions[0].action).toBe('NOT_PROMOTED');
    expect(decisions[0].reason).toMatch(/no non-core dynamic symbol/i);
  });
});

describe('computeCapacitySnapshot', () => {
  it('computes utilization and empty slots correctly', () => {
    const snap = computeCapacitySnapshot(['A', 'B', 'C'], ['A'], 10);
    expect(snap.activeCount).toBe(3);
    expect(snap.coreCount).toBe(1);
    expect(snap.dynamicCount).toBe(2);
    expect(snap.emptySlots).toBe(7);
    expect(snap.utilizationPct).toBeCloseTo(0.3, 5);
  });

  it('does not divide by zero when effectiveCap is 0', () => {
    const snap = computeCapacitySnapshot([], [], 0);
    expect(snap.utilizationPct).toBe(0);
  });
});

describe('detectStarvedCandidates', () => {
  it('flags a symbol with consecutive PROMOTE recommendations that was never actually activated', () => {
    const recs = new Map([
      ['STARVED', [true, true, true, false]],
      ['NEWLY_STARVED', [true]],
      ['NOT_STARVED', [false, true, true]],
    ]);
    const starved = detectStarvedCandidates(recs, new Set(), 3);
    expect(starved).toContain('STARVED');
    expect(starved).not.toContain('NEWLY_STARVED'); // only 1 consecutive cycle, below threshold
    expect(starved).not.toContain('NOT_STARVED'); // most recent cycle broke the streak
  });

  it('never flags a symbol that is already active, regardless of its history', () => {
    const recs = new Map([['ACTIVE', [true, true, true]]]);
    const starved = detectStarvedCandidates(recs, new Set(['ACTIVE']), 2);
    expect(starved).not.toContain('ACTIVE');
  });
});
