import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { continuousIntelligence } from '../config/continuousIntelligence';
import { tradingSafety } from '../config/tradingSafety';
import { orderDeferredSubscriptionCandidates, planSnapshotHotSwap } from './OpportunityDiscovery';
import { expireStaleCandidates, getCandidate, listCandidates, recordSubscriptionDeferral, resetCandidatesForTests, upsertCandidate } from './candidateLifecycle';

describe('bounded subscription deferral fairness', () => {
  const enabled = continuousIntelligence.subscriptionDeferralFairnessEnabled;
  const now = 1_000_000;
  const candidate = (symbol: string, momentumScore: number) =>
    ({ symbol, momentumScore, intradayPctChange: 0, rangeExpansion: 0, relativeVolume: 0 });
  const options = () => ({
    top: [candidate('RBLX', 3), candidate('CIEN', 2)], active: new Set(['WEAK']),
    activeDynamic: ['WEAK'], emptySlots: 0, maxSwaps: 5,
    scoreEdge: continuousIntelligence.snapshotMomentumScoreEdge, scoreOf: () => 0,
  });
  function defer(symbol = 'CIEN', start = now - 100) {
    upsertCandidate({ symbol, state: 'WATCHING', now: start });
    for (let i = 0; i < continuousIntelligence.subscriptionDeferralFairnessMinCycles; i++) {
      recordSubscriptionDeferral(symbol, false, start + i, tradingSafety.recentCandidatePriorityMaxAgeMs);
    }
  }
  beforeEach(() => { resetCandidatesForTests(); continuousIntelligence.subscriptionDeferralFairnessEnabled = true; });
  afterEach(() => { resetCandidatesForTests(); continuousIntelligence.subscriptionDeferralFairnessEnabled = enabled; });

  it('lets a qualified repeatedly deferred challenger win the same single swap without inflating its score', () => {
    defer();
    const opts = options();
    const ordered = orderDeferredSubscriptionCandidates(opts, new Set(['CIEN']), now, now);
    expect(ordered.map(c => c.symbol)).toEqual(['CIEN', 'RBLX']);
    expect(ordered[0].momentumScore).toBe(2);
    expect(planSnapshotHotSwap({ ...opts, top: ordered })).toEqual(['CIEN']);
    recordSubscriptionDeferral('CIEN', true, now, tradingSafety.recentCandidatePriorityMaxAgeMs);
    expect(getCandidate('CIEN')?.subscriptionWait).toBeUndefined();
    expect(getCandidate('CIEN')?.lastIdeaAt).toBeNull(); // request never fabricates an idea/assessment
  });

  it('preserves score rank when disabled, below the wait floor, or filling empty slots', () => {
    const opts = options();
    expect(orderDeferredSubscriptionCandidates(opts, new Set(['CIEN']), now, now)).toBe(opts.top);
    defer(); continuousIntelligence.subscriptionDeferralFairnessEnabled = false;
    expect(orderDeferredSubscriptionCandidates(opts, new Set(['CIEN']), now, now)).toBe(opts.top);
    continuousIntelligence.subscriptionDeferralFairnessEnabled = true;
    const empty = { ...opts, emptySlots: 1 };
    expect(orderDeferredSubscriptionCandidates(empty, new Set(['CIEN']), now, now)).toBe(empty.top);
  });

  it('cannot bypass score margin, protected incumbents, zero budget, zero evidence, or inactive admission', () => {
    defer();
    const opts = options();
    for (const blocked of [
      { ...opts, scoreOf: () => 100 }, { ...opts, activeDynamic: [] },
      { ...opts, maxSwaps: 0 }, { ...opts, top: [candidate('RBLX', 3), candidate('CIEN', 0)] },
    ]) expect(orderDeferredSubscriptionCandidates(blocked, new Set(['CIEN']), now, now)).toBe(blocked.top);
    expect(orderDeferredSubscriptionCandidates(opts, new Set(), now, now)).toBe(opts.top);
  });

  it('rejects stale, missing, future and non-finite snapshot evidence and stale wait history', () => {
    defer(); const opts = options();
    const maxAge = tradingSafety.recentCandidatePriorityMaxAgeMs;
    for (const at of [null, NaN, now + 1, now - maxAge - 1]) {
      expect(orderDeferredSubscriptionCandidates(opts, new Set(['CIEN']), now, at)).toBe(opts.top);
    }
    expect(orderDeferredSubscriptionCandidates(opts, new Set(['CIEN']), now + maxAge + 1, now + maxAge + 1)).toBe(opts.top);
  });

  it('uses oldest real wait and deterministic alphabetical ties, with bounded canonical records', () => {
    defer('CIEN', now - 100); defer('ACN', now - 200);
    const opts = { ...options(), top: [candidate('RBLX', 3), candidate('CIEN', 2), candidate('ACN', 1)] };
    expect(orderDeferredSubscriptionCandidates(opts, new Set(['CIEN', 'ACN']), now, now)[0].symbol).toBe('ACN');
    recordSubscriptionDeferral('ACN', false, now - 198, tradingSafety.recentCandidatePriorityMaxAgeMs);
    expect(getCandidate('ACN')?.subscriptionWait?.deferredCycles).toBe(continuousIntelligence.subscriptionDeferralFairnessMinCycles);
    resetCandidatesForTests(); defer('CIEN'); defer('ACN');
    expect(orderDeferredSubscriptionCandidates(opts, new Set(['CIEN', 'ACN']), now, now)[0].symbol).toBe('ACN');
  });

  it('resets discontinuous wait evidence and does not create records for non-candidates', () => {
    defer(); const maxAge = tradingSafety.recentCandidatePriorityMaxAgeMs;
    recordSubscriptionDeferral('CIEN', false, now + maxAge, maxAge);
    expect(getCandidate('CIEN')?.subscriptionWait?.deferredCycles).toBe(1);
    recordSubscriptionDeferral('NONE', false, now, maxAge);
    expect(getCandidate('NONE')).toBeUndefined();
  });

  it('retains waiting evidence during a universe refresh without exceeding the existing record cap', () => {
    defer();
    for (let i = 0; i <= continuousIntelligence.maxCandidateRecords; i++) {
      upsertCandidate({ symbol: `REC${i}`, state: 'DISCOVERED', now });
    }
    expect(listCandidates()).toHaveLength(continuousIntelligence.maxCandidateRecords);
    expect(getCandidate('CIEN')?.subscriptionWait?.deferredCycles).toBe(continuousIntelligence.subscriptionDeferralFairnessMinCycles);
    expireStaleCandidates(tradingSafety.recentCandidatePriorityMaxAgeMs, now + tradingSafety.recentCandidatePriorityMaxAgeMs + 1);
    expect(getCandidate('CIEN')?.subscriptionWait).toBeUndefined();
  });
});
