/**
 * coverageReconciler tests (2026-10-06, local-only, Part B workstream H).
 * Classification is a pure function over the injected CoverageEvidenceStore -
 * every test below runs against fakes, no DB, no network.
 */
import { describe, it, expect } from 'vitest';
import {
  reconcileMover,
  evaluateFilterPremise,
  PRIMARY_FATES,
  type CoverageEvidenceStore,
  type DiscoveryDecision,
  type ConsensusTrace,
  type RiskAssessmentEvidence,
  type TradePlanEvidence,
  type PrimaryFate,
} from './coverageReconciler';
import type { MoverCohortMember, MoverScreenConfig } from './moverCohort';

const TEST_CFG: MoverScreenConfig = {
  minPrice: 5, maxPrice: 10000, minDollarVolume: 5_000_000,
  maxSpreadBps: 50, minAdvShares: 500_000, fetchTopNPerSide: 50, scanTopNPerSide: 20,
};

const TRADING_DATE = '2026-10-05';

function member(overrides: Partial<MoverCohortMember> = {}): MoverCohortMember {
  return {
    symbol: 'MOVE',
    direction: 'GAINER',
    eodMovePct: 12.5,
    referencePrice: 100,
    dayVolumeShares: 2_000_000,
    screenerRank: 7,
    beyondScanCap: false,
    inTradableUniverse: true,
    screenEvidence: { price: 112.5, dollarVolume: 225_000_000, spreadBps: 8, spreadCrossed: false, advShares: 3_000_000, spreadScreened: true },
    ...overrides,
  };
}

interface FakeEvidence {
  decisions?: DiscoveryDecision[];
  news?: number;
  sub?: { requested: number; acknowledged: number };
  quant?: number;
  ideas?: number;
  consensusRejected?: { rejected: boolean; reason: string | null };
  traces?: ConsensusTrace[];
  risks?: RiskAssessmentEvidence[];
  fillsOrders?: { orders: number; fills: number };
  missed?: { classification: string } | null;
  plans?: TradePlanEvidence[];
  focus?: { primary: string[]; secondary: string[]; watch: string[]; rejected: string[] } | null;
  reservations?: number;
  funnelRan?: boolean;
  scanTopN?: number;
  throwOn?: 'getDiscoveryDecisions' | 'moversFunnelRan';
}

function fakeStore(ev: FakeEvidence = {}): CoverageEvidenceStore {
  const maybeThrow = (what: FakeEvidence['throwOn']) => {
    if (ev.throwOn === what) throw new Error(`fake ${what} exploded`);
  };
  return {
    getDiscoveryDecisions: async () => { maybeThrow('getDiscoveryDecisions'); return ev.decisions ?? []; },
    getNewsEventCount: async () => ev.news ?? 0,
    getSubscribeCounts: async () => ev.sub ?? { requested: 0, acknowledged: 0 },
    getQuantAssessmentCount: async () => ev.quant ?? 0,
    getIdeaEventCount: async () => ev.ideas ?? 0,
    getConsensusTerminalRejected: async () => ev.consensusRejected ?? { rejected: false, reason: null },
    getConsensusTraces: async () => ev.traces ?? [],
    getRiskAssessments: async () => ev.risks ?? [],
    getFillsAndOrders: async () => ev.fillsOrders ?? { orders: 0, fills: 0 },
    getMissedOpportunity: async () => ev.missed ?? null,
    getTradePlans: async () => ev.plans ?? [],
    getFocusSymbols: async () => ev.focus ?? null,
    getReservationCount: async () => ev.reservations ?? 0,
    moversFunnelRan: async () => { maybeThrow('moversFunnelRan'); return ev.funnelRan ?? true; },
    getScanTopNPerSide: () => ev.scanTopN ?? TEST_CFG.scanTopNPerSide,
  };
}

const reconcile = (m: MoverCohortMember, ev: FakeEvidence = {}) =>
  reconcileMover(m, TRADING_DATE, fakeStore(ev), TEST_CFG);

describe('coverageReconciler classification ladder', () => {
  it('classifies NEVER_SEEN for a mover with zero lineage rows (survivorship-bias fix)', async () => {
    const v = await reconcile(member(), { funnelRan: true });
    expect(v.primaryFate).toBe('NEVER_SEEN');
    // Funnel ran, rank within cap, in universe, bars available -> OTHER with evidence.
    expect(v.neverSeenCause).toBe('OTHER');
    expect(v.secondaryReasons.join(' ')).toMatch(/zero discovery-lineage/);
    expect(v.filterReason).toBeNull();
    expect(v.premarketKnownBy).toEqual({ plan0400: false, refresh0915: false, fastLane: false, discovery: false });
    expect(v.outcomeWindows.eod.movePct).toBeCloseTo(12.5, 6);
    expect(v.referencePrice).toBe(100);
  });

  it('NEVER_SEEN cause = RANK_CAP when the screener rank exceeded the scan cap', async () => {
    const v = await reconcile(member({ screenerRank: 45, beyondScanCap: true }), { funnelRan: true });
    expect(v.primaryFate).toBe('NEVER_SEEN');
    expect(v.neverSeenCause).toBe('RANK_CAP');
    expect(v.secondaryReasons.join(' ')).toMatch(/rank 45.*cap \(20\)/);
  });

  it('NEVER_SEEN cause = MARKET_MOVER_SOURCE when the funnel never ran that day', async () => {
    const v = await reconcile(member(), { funnelRan: false });
    expect(v.primaryFate).toBe('NEVER_SEEN');
    expect(v.neverSeenCause).toBe('MARKET_MOVER_SOURCE');
  });

  it('NEVER_SEEN cause = DATA_UNAVAILABLE when no bars exist for the symbol', async () => {
    const v = await reconcile(member({ eodMovePct: null, referencePrice: null, dayVolumeShares: null }), { funnelRan: true });
    expect(v.primaryFate).toBe('NEVER_SEEN');
    expect(v.neverSeenCause).toBe('DATA_UNAVAILABLE');
  });

  it('NEVER_SEEN cause = UNIVERSE_COVERAGE when the symbol is outside the tradable universe', async () => {
    const v = await reconcile(member({ inTradableUniverse: false }), { funnelRan: true });
    expect(v.primaryFate).toBe('NEVER_SEEN');
    expect(v.neverSeenCause).toBe('UNIVERSE_COVERAGE');
  });

  it('NEVER_SEEN cause = UNKNOWN (never invented) when cause determination hits a data gap', async () => {
    const v = await reconcile(member(), { funnelRan: true, throwOn: 'moversFunnelRan' });
    expect(v.primaryFate).toBe('NEVER_SEEN');
    expect(v.neverSeenCause).toBe('UNKNOWN');
  });

  it('classifies DISCOVERED_FILTERED from lineage showing a filter reason, with premise check', async () => {
    const v = await reconcile(member({ referencePrice: 2.5 }), {
      decisions: [{ ts: 1, admitted: false, source: 'MARKET_MOVER', reason: 'PRICE', price: 2.4 }],
    });
    expect(v.primaryFate).toBe('DISCOVERED_FILTERED');
    expect(v.filterReason).toBe('PRICE');
    // Premise "price below $5 floor" holds at the $2.50 reference -> correct filter.
    expect(v.filterPremiseCorrect).toBe(true);
    expect(v.neverSeenCause).toBeNull();
  });

  it('DISCOVERED_FILTERED marks an incorrect premise when EOD evidence contradicts it', async () => {
    // Filtered on ADV_DATA_UNAVAILABLE, but bars exist now -> the fetch failed, not the symbol.
    const v = await reconcile(member(), {
      decisions: [{ ts: 1, admitted: false, source: 'MARKET_MOVER', reason: 'ADV_DATA_UNAVAILABLE', price: 100 }],
    });
    expect(v.primaryFate).toBe('DISCOVERED_FILTERED');
    expect(v.filterReason).toBe('ADV_DATA_UNAVAILABLE');
    expect(v.filterPremiseCorrect).toBe(false);
  });

  it('classifies RISK_REJECTED from a risk_assessments rejection', async () => {
    const v = await reconcile(member(), {
      decisions: [{ ts: 1, admitted: true, source: 'MARKET_MOVER', reason: null, price: 100 }],
      sub: { requested: 1, acknowledged: 1 },
      quant: 2,
      ideas: 1,
      traces: [{ lifecycleStatus: 'CONSENSUS_REACHED', terminalReason: null, terminalReasonCode: null }],
      risks: [{ approved: false, rejectionGate: 'max_position_concentration' }],
    });
    expect(v.primaryFate).toBe('RISK_REJECTED');
    expect(v.secondaryReasons.join(' ')).toMatch(/max_position_concentration/);
  });

  it('classifies CONSENSUS_REJECTED from a NO_CONSENSUS trace', async () => {
    const v = await reconcile(member(), {
      decisions: [{ ts: 1, admitted: true, source: 'MARKET_MOVER', reason: null, price: 100 }],
      traces: [{ lifecycleStatus: 'NO_CONSENSUS', terminalReason: 'no consensus', terminalReasonCode: 'LOW_CONFIDENCE' }],
    });
    expect(v.primaryFate).toBe('CONSENSUS_REJECTED');
    expect(v.secondaryReasons.join(' ')).toMatch(/LOW_CONFIDENCE/);
  });

  it('classifies ACTED_ON when a fill was recorded (deepest stage wins)', async () => {
    const v = await reconcile(member(), {
      traces: [{ lifecycleStatus: 'FILLED', terminalReason: null, terminalReasonCode: null }],
      risks: [{ approved: true, rejectionGate: null }],
      fillsOrders: { orders: 1, fills: 1 },
    });
    expect(v.primaryFate).toBe('ACTED_ON');
  });

  it('classifies APPROVED_NOT_EXECUTED when consensus+risk approved but no order exists', async () => {
    const v = await reconcile(member(), {
      traces: [{ lifecycleStatus: 'CONSENSUS_REACHED', terminalReason: null, terminalReasonCode: null }],
      risks: [{ approved: true, rejectionGate: null }],
    });
    expect(v.primaryFate).toBe('APPROVED_NOT_EXECUTED');
  });

  it('classifies STRATEGY_NO_SETUP when quant evaluated but no idea was emitted', async () => {
    const v = await reconcile(member(), {
      decisions: [{ ts: 1, admitted: true, source: 'BROAD_UNIVERSE', reason: null, price: 100 }],
      sub: { requested: 1, acknowledged: 1 },
      quant: 3,
    });
    expect(v.primaryFate).toBe('STRATEGY_NO_SETUP');
  });

  it('classifies SUBSCRIBED_NOT_EVALUATED when subscribed but never quant-assessed', async () => {
    const v = await reconcile(member(), { sub: { requested: 2, acknowledged: 1 } });
    expect(v.primaryFate).toBe('SUBSCRIBED_NOT_EVALUATED');
  });

  it('classifies DISCOVERED_NOT_PROMOTED when admitted but never subscribed', async () => {
    const v = await reconcile(member(), {
      decisions: [{ ts: 1, admitted: true, source: 'MARKET_MOVER', reason: null, price: 100 }],
    });
    expect(v.primaryFate).toBe('DISCOVERED_NOT_PROMOTED');
    expect(v.premarketKnownBy.discovery).toBe(true);
  });

  it('classifies DISCOVERED_NOT_PROMOTED for news-only coverage (news is a discovery source)', async () => {
    const v = await reconcile(member(), { news: 3 });
    expect(v.primaryFate).toBe('DISCOVERED_NOT_PROMOTED');
    expect(v.secondaryReasons.join(' ')).toMatch(/news/);
  });

  it('classifies EVALUATED when a premarket plan existed but nothing downstream did', async () => {
    const v = await reconcile(member(), {
      plans: [{ status: 'READY', direction: 'BUY', refreshVersion: 1 }],
      focus: { primary: ['MOVE'], secondary: [], watch: [], rejected: [] },
      reservations: 1,
    });
    expect(v.primaryFate).toBe('EVALUATED');
    expect(v.premarketKnownBy).toEqual({ plan0400: true, refresh0915: true, fastLane: true, discovery: false });
  });

  it('classifies EVALUATED when an idea was emitted but no consensus trace was recorded', async () => {
    const v = await reconcile(member(), { ideas: 1 });
    expect(v.primaryFate).toBe('EVALUATED');
  });

  it('degrades to INSUFFICIENT_EVIDENCE when the evidence store fails - never a fabricated fate', async () => {
    const v = await reconcile(member(), { throwOn: 'getDiscoveryDecisions' });
    expect(v.primaryFate).toBe('INSUFFICIENT_EVIDENCE');
    expect(v.neverSeenCause).toBeNull();
  });
});

describe('evaluateFilterPremise', () => {
  it('judges PRICE against the mandate floor', () => {
    expect(evaluateFilterPremise('PRICE', member({ referencePrice: 2.5 }), TEST_CFG)).toBe(true);
    expect(evaluateFilterPremise('PRICE', member({ referencePrice: 50 }), TEST_CFG)).toBe(false);
    expect(evaluateFilterPremise('PRICE', member({ referencePrice: null }), TEST_CFG)).toBeNull();
  });
  it('judges DOLLAR_VOLUME against EOD dollar volume', () => {
    // 112.5 * 2M shares = $225M >> $5M floor -> premise wrong.
    expect(evaluateFilterPremise('DOLLAR_VOLUME', member(), TEST_CFG)).toBe(false);
    expect(evaluateFilterPremise('DOLLAR_VOLUME', member({ dayVolumeShares: 100 }), TEST_CFG)).toBe(true);
  });
  it('returns null for spread reasons - no EOD spread evidence exists', () => {
    expect(evaluateFilterPremise('SPREAD', member(), TEST_CFG)).toBeNull();
    expect(evaluateFilterPremise('SPREAD_CROSSED', member(), TEST_CFG)).toBeNull();
    expect(evaluateFilterPremise('BOGUS_REASON', member(), TEST_CFG)).toBeNull();
  });
  it('judges RANK_CAP against the scan cap', () => {
    expect(evaluateFilterPremise('RANK_CAP', member({ screenerRank: 45 }), TEST_CFG)).toBe(true);
    expect(evaluateFilterPremise('RANK_CAP', member({ screenerRank: 7 }), TEST_CFG)).toBe(false);
  });
});

describe('exactly-one-primary-fate invariant (property test)', () => {
  // Seeded PRNG - deterministic across runs.
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pick = <T>(r: () => number, arr: T[]): T => arr[Math.floor(r() * arr.length)];

  it('every evidence combination yields exactly one valid fate with coherent auxiliaries', async () => {
    const rng = mulberry32(20261006);
    for (let i = 0; i < 250; i += 1) {
      const r = rng;
      const admitted = r() < 0.5;
      const ev: FakeEvidence = {
        decisions: r() < 0.4
          ? [{ ts: 1, admitted, source: pick(r, ['MARKET_MOVER', 'BROAD_UNIVERSE']), reason: admitted ? null : pick(r, ['PRICE', 'ADV_BELOW_FLOOR', 'SPREAD', null]), price: 50 }]
          : [],
        news: r() < 0.2 ? 2 : 0,
        sub: { requested: r() < 0.35 ? 1 : 0, acknowledged: r() < 0.3 ? 1 : 0 },
        quant: r() < 0.35 ? 2 : 0,
        ideas: r() < 0.2 ? 1 : 0,
        consensusRejected: { rejected: r() < 0.15, reason: 'X' },
        traces: r() < 0.3
          ? [{ lifecycleStatus: pick(r, ['NO_CONSENSUS', 'CONSENSUS_REACHED', 'ANALYZING', 'RISK_APPROVED']), terminalReason: null, terminalReasonCode: null }]
          : [],
        risks: r() < 0.2 ? [{ approved: r() < 0.5, rejectionGate: 'g' }] : [],
        fillsOrders: { orders: r() < 0.12 ? 1 : 0, fills: r() < 0.06 ? 1 : 0 },
        missed: r() < 0.15 ? { classification: pick(r, ['CONSENSUS_REJECTION', 'RISK_REJECTION', 'SUBSCRIPTION_MISS', 'AGENT_MISS', 'THESIS_INVALIDATED', 'EXECUTION_MISS']) } : null,
        plans: r() < 0.2 ? [{ status: 'READY', direction: 'BUY', refreshVersion: pick(r, [1, 2]) }] : [],
        focus: r() < 0.15 ? { primary: ['MOVE'], secondary: [], watch: [], rejected: [] } : null,
        reservations: r() < 0.1 ? 1 : 0,
        funnelRan: r() < 0.7,
      };
      const m = member({
        eodMovePct: r() < 0.05 ? null : 5 + r() * 20,
        referencePrice: r() < 0.05 ? null : 100,
        screenerRank: 1 + Math.floor(r() * 50),
        beyondScanCap: r() < 0.3,
        inTradableUniverse: r() < 0.9,
      });
      const v = await reconcile(m, ev);
      // Exactly one fate, always a valid enum member.
      expect(PRIMARY_FATES as readonly string[]).toContain(v.primaryFate);
      // Auxiliaries are coherent with the fate.
      expect(Array.isArray(v.secondaryReasons)).toBe(true);
      expect(v.secondaryReasons.length).toBeGreaterThan(0);
      expect(v.neverSeenCause !== null).toBe(v.primaryFate === 'NEVER_SEEN');
      expect(v.filterReason !== null).toBe(v.primaryFate === 'DISCOVERED_FILTERED');
      if (v.primaryFate === 'DISCOVERED_FILTERED') {
        expect(typeof v.filterReason).toBe('string');
      } else {
        expect(v.filterPremiseCorrect).toBeNull();
      }
      expect(typeof v.premarketKnownBy.plan0400).toBe('boolean');
      expect(typeof v.premarketKnownBy.refresh0915).toBe('boolean');
      expect(typeof v.premarketKnownBy.fastLane).toBe('boolean');
      expect(typeof v.premarketKnownBy.discovery).toBe('boolean');
      expect(typeof v.symbol).toBe('string');
    }
  }, 30000);

  it('every PrimaryFate is reachable by at least one evidence shape (no dead enum members)', async () => {
    const shapes: Array<{ fate: PrimaryFate; ev: FakeEvidence; m?: Partial<MoverCohortMember> }> = [
      { fate: 'ACTED_ON', ev: { fillsOrders: { orders: 1, fills: 1 } } },
      { fate: 'APPROVED_NOT_EXECUTED', ev: { traces: [{ lifecycleStatus: 'CONSENSUS_REACHED', terminalReason: null, terminalReasonCode: null }], risks: [{ approved: true, rejectionGate: null }] } },
      { fate: 'CONSENSUS_REJECTED', ev: { traces: [{ lifecycleStatus: 'NO_CONSENSUS', terminalReason: null, terminalReasonCode: 'X' }] } },
      { fate: 'RISK_REJECTED', ev: { risks: [{ approved: false, rejectionGate: 'g' }] } },
      { fate: 'STRATEGY_NO_SETUP', ev: { quant: 1 } },
      { fate: 'EVALUATED', ev: { plans: [{ status: 'READY', direction: 'BUY', refreshVersion: 1 }] } },
      { fate: 'SUBSCRIBED_NOT_EVALUATED', ev: { sub: { requested: 1, acknowledged: 0 } } },
      { fate: 'DISCOVERED_FILTERED', ev: { decisions: [{ ts: 1, admitted: false, source: 'MARKET_MOVER', reason: 'PRICE', price: 2 }] } },
      { fate: 'DISCOVERED_NOT_PROMOTED', ev: { decisions: [{ ts: 1, admitted: true, source: 'MARKET_MOVER', reason: null, price: 50 }] } },
      { fate: 'NEVER_SEEN', ev: {} },
      { fate: 'INSUFFICIENT_EVIDENCE', ev: { throwOn: 'getDiscoveryDecisions' } },
    ];
    for (const { fate, ev, m } of shapes) {
      const v = await reconcile(member(m), ev);
      expect(v.primaryFate).toBe(fate);
    }
  });
});
