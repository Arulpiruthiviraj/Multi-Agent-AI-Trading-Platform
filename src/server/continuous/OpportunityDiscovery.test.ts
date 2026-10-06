/**
 * OpportunityDiscovery — subscribe-only discovery + SnapshotScanner hot-swap.
 * Never emits TRADE_IDEA_GENERATED.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { continuousIntelligence } from '../config/continuousIntelligence';
import { getTradingDateStr } from '../core/TradingCalendar';

function liquidCompletedBars() {
  const day = new Date(`${getTradingDateStr(new Date(Date.now()))}T12:00:00Z`);
  return Array.from({ length: continuousIntelligence.broadUniverseAdvLookbackDays }, () => {
    do { day.setUTCDate(day.getUTCDate() - 1); } while ([0, 6].includes(day.getUTCDay()));
    return { t: day.toISOString(), v: 2_000_000 };
  });
}
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { marketDataWorker } from '../services/MarketDataWorker';
import {
  runOpportunityScan,
  resetOpportunityScanForTests,
  evaluateOpportunityCandidate,
  getOpportunityScanUniverse,
  planSnapshotHotSwap,
  blendedHotSwapScore,
} from './OpportunityDiscovery';
import * as SnapshotScanner from './SnapshotScanner';
import * as MarketUniverseScanner from './MarketUniverseScanner';
import { resetBroadUniverseAllocatorForTests } from './BroadUniverseSubscriptionAllocator';
import { structuredLogger } from '../observability/StructuredLogger';

const FLAG_O = continuousIntelligence.opportunityLoopEnabledEnvVar;

/** getCachedBroadUniverseCandidatesWithVolume() shape - descending dollar volume in array order,
 *  matching the real cache's own dollar-volume-sorted admission list. gapPct defaults to null
 *  (no gap evidence) - tests that need a real gap pass gapPctBySymbol explicitly. */
function withVolume(symbols: string[], startingVolume = 100_000_000, gapPctBySymbol: Record<string, number | null> = {}): { symbol: string; dollarVolume: number; gapPct: number | null }[] {
  return symbols.map((symbol, i) => ({ symbol, dollarVolume: startingVolume - i * 1000, gapPct: gapPctBySymbol[symbol] ?? null }));
}

/**
 * 2026-09-30 (IOVA request-to-evaluation gap fix): OpportunityDiscovery.ts's hot-swap planner now
 * ranks eviction candidates from MarketDataWorker.getEvictionEligibleDynamicSymbols() (the
 * canonical, dwell/rescue/protected-aware eviction-eligible subset), not the raw getDynamicSymbols()
 * superset. Every existing test in this file that mocked getDynamicSymbols() to represent "the
 * dynamic incumbents, all assumed evictable" needs the SAME array mocked for the new method too -
 * this helper keeps that in one place instead of duplicating two vi.spyOn calls at every site. Tests
 * that specifically want to prove dwell/rescue-INELIGIBLE incumbents are excluded mock
 * getEvictionEligibleDynamicSymbols() directly with a narrower set instead of using this helper.
 */
function mockDynamicSymbols(symbols: string[]) {
  vi.spyOn(marketDataWorker, 'getDynamicSymbols').mockReturnValue(symbols);
  vi.spyOn(marketDataWorker, 'getEvictionEligibleDynamicSymbols').mockReturnValue(symbols);
}

afterEach(() => {
  delete process.env[FLAG_O];
  resetOpportunityScanForTests();
  SnapshotScanner.resetSnapshotScannerForTests();
  resetBroadUniverseAllocatorForTests();
  vi.restoreAllMocks();
});

describe('OpportunityDiscovery', () => {
  beforeEach(() => {
    resetOpportunityScanForTests();
  });

  it('never emits TRADE_IDEA_GENERATED even when the opportunity loop is on', async () => {
    process.env[FLAG_O] = 'true';
    vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([]);
    const ideas: unknown[] = [];
    const onIdea = (p: unknown) => ideas.push(p);
    eventBus.subscribe(EVENTS.TRADE_IDEA_GENERATED, onIdea);
    await runOpportunityScan(new Date('2026-08-21T18:00:00.000Z'));
    eventBus.unsubscribe(EVENTS.TRADE_IDEA_GENERATED, onIdea);
    expect(ideas).toHaveLength(0);
  });

  it('includes the liquid snapshot universe in the scan set', () => {
    const universe = getOpportunityScanUniverse();
    expect(universe.length).toBeGreaterThanOrEqual(100);
    expect(universe).toEqual(expect.arrayContaining(['NVDA', 'TSLA', 'AMZN', 'DIA']));
  });

  it('rejects garbage tickers before shortlist', () => {
    expect(evaluateOpportunityCandidate('NOT A TICKER').action).toBe('reject');
  });

  it('planSnapshotHotSwap fills empty slots then replaces weakest dynamics', () => {
    const planned = planSnapshotHotSwap({
      top: [
        { symbol: 'AMD', intradayPctChange: 5, rangeExpansion: 0.01, relativeVolume: 2, momentumScore: 10 },
        { symbol: 'TSLA', intradayPctChange: 4, rangeExpansion: 0.01, relativeVolume: 2, momentumScore: 9 },
      ],
      active: new Set(['SPY', 'QQQ', 'GLD', 'MSFT']),
      activeDynamic: ['MSFT'],
      emptySlots: 0,
      maxSwaps: 4,
      scoreEdge: 0.15,
      scoreOf: (s) => (s === 'MSFT' ? 1 : 0),
    });
    // At full capacity, at most 1 replacement even if maxSwaps is higher.
    expect(planned).toEqual(['AMD']);
  });

  it('at full capacity, planSnapshotHotSwap never emits more than one swap', () => {
    const planned = planSnapshotHotSwap({
      top: [
        { symbol: 'AMD', intradayPctChange: 5, rangeExpansion: 0.01, relativeVolume: 2, momentumScore: 10 },
        { symbol: 'TSLA', intradayPctChange: 4, rangeExpansion: 0.01, relativeVolume: 2, momentumScore: 9 },
        { symbol: 'COIN', intradayPctChange: 3, rangeExpansion: 0.01, relativeVolume: 2, momentumScore: 8 },
      ],
      active: new Set(['SPY', 'QQQ', 'GLD', 'MSFT', 'AAPL', 'NVDA']),
      activeDynamic: ['MSFT', 'AAPL', 'NVDA'],
      emptySlots: 0,
      maxSwaps: 1,
      scoreEdge: 0.15,
      scoreOf: () => 0.5,
    });
    expect(planned).toHaveLength(1);
    expect(planned[0]).toBe('AMD');
  });

  it('during RTH, hot-swaps via SNAPSHOT_HOT_SWAP when stream is full (max 1)', async () => {
    process.env[FLAG_O] = 'true';
    const cap = continuousIntelligence.maxActiveSubscriptions;
    vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(
      Array.from({ length: cap }, (_, i) => (i < 3 ? ['SPY', 'QQQ', 'GLD'][i] : `ZZ${i}`)),
    );
    mockDynamicSymbols(
      Array.from({ length: cap - 3 }, (_, i) => `ZZ${i + 3}`),
    );
    vi.spyOn(marketDataWorker, 'getDynamicMomentumScore').mockReturnValue(0.5);
    vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([
      {
        symbol: 'AMD',
        intradayPctChange: 6,
        rangeExpansion: 0.02,
        relativeVolume: 2.5,
        momentumScore: 6,
      },
      {
        symbol: 'TSLA',
        intradayPctChange: 4,
        rangeExpansion: 0.02,
        relativeVolume: 3,
        momentumScore: 5,
      },
    ]);
    vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockImplementation((s) =>
      (s === 'AMD' ? 6 : s === 'TSLA' ? 5 : null),
    );

    const subs: Array<{ symbol?: string; reason?: string }> = [];
    const onSub = (p: { symbol?: string; reason?: string }) => subs.push(p);
    eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);

    const stats = await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z')); // 10:00 ET
    eventBus.unsubscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);

    expect(stats.rth).toBe(true);
    expect(stats.ideasEmitted).toBe(0);
    expect(stats.subscribeRequested).toBe(1);
    expect(subs).toHaveLength(1);
    expect(subs[0].reason).toBe('SNAPSHOT_HOT_SWAP');
    expect(subs[0].symbol).toBe('AMD');

    // Phase 9 (same-candidate convergence): a real momentum-ranked subscribe request also
    // registers into recentCandidateRegistry, so Fundamental/MacroAgent's priority round-robin
    // converges toward the broad-universe discovery system's own real ranking too.
    const { getRecentCandidates } = await import('../core/recentCandidateRegistry');
    expect(getRecentCandidates(300000)).toContain('AMD');
  });

  it('2026-09-16 regression: when momentum rotation is on and slots remain empty after its own picks, tops up subscribe requests from the broad-universe ADV-gated admission list (previously: admitted symbols never got a subscribe request at all)', async () => {
    process.env[FLAG_O] = 'true';
    expect(continuousIntelligence.momentumRotationEnabled).toBe(true);
    // Isolate the scenario: momentum's own static universe (seed/watch/momentum-scan lists) is
    // emptied for this test so the only source of a top-up candidate is the mocked broad-universe
    // admission list below - proves the fix wires that specific, previously-disconnected path,
    // not just that "some" symbol happens to fill a slot.
    const originalSeed = continuousIntelligence.seedSymbols;
    const originalWatch = continuousIntelligence.watchUniverseSymbols;
    const originalMomentumScan = continuousIntelligence.momentumScanUniverseSymbols;
    (continuousIntelligence as any).seedSymbols = [];
    (continuousIntelligence as any).watchUniverseSymbols = [];
    (continuousIntelligence as any).momentumScanUniverseSymbols = [];
    try {
      // Only 3 of the (much larger) real cap active -> plenty of empty slots, same shape as the
      // real live gap (19 active of 90 IBKR cap).
      vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(['SPY', 'QQQ', 'GLD']);
      mockDynamicSymbols([]);
      vi.spyOn(marketDataWorker, 'getDynamicMomentumScore').mockReturnValue(0);
      // Momentum's own universe has exactly one pick - real production shape: a small, static,
      // curated list, not the broad-universe admission list.
      vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([
        { symbol: 'AAPL', intradayPctChange: 2, rangeExpansion: 0.01, relativeVolume: 1.5, momentumScore: 3 },
      ]);
      vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockImplementation((s) => (s === 'AAPL' ? 3 : null));
      // A symbol that cleared the ADV gate today (real shape: AMZN-class case) but is NOT in
      // momentum's own static universe at all.
      vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(['AMZN']));

      const subs: Array<{ symbol?: string; reason?: string }> = [];
      const onSub = (p: { symbol?: string; reason?: string }) => subs.push(p);
      eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);
      const stats = await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));
      eventBus.unsubscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);

      expect(stats.ideasEmitted).toBe(0); // still never a trade idea
      const symbols = subs.map((s) => s.symbol);
      expect(symbols).toContain('AAPL'); // momentum's own pick, unaffected
      expect(symbols).toContain('AMZN'); // the real gap this fix closes
      const amznSub = subs.find((s) => s.symbol === 'AMZN');
      expect(amznSub?.reason).toBe('BROAD_UNIVERSE_TOPUP');
    } finally {
      (continuousIntelligence as any).seedSymbols = originalSeed;
      (continuousIntelligence as any).watchUniverseSymbols = originalWatch;
      (continuousIntelligence as any).momentumScanUniverseSymbols = originalMomentumScan;
    }
  });

  describe('2026-09-29 discovery-to-evaluation coverage fix (docs/audits/archive/ARGUS_MIDDAY_ZERO_TRADE_2026-09-29.md): broad-universe hot-swap challengers at FULL capacity', () => {
    it('an IOVA-class broad-universe symbol (real intraday gap, never part of the momentum universe) can win a hot-swap slot at FULL capacity, not just an empty one', async () => {
      process.env[FLAG_O] = 'true';
      const cap = continuousIntelligence.maxActiveSubscriptions;
      vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(
        Array.from({ length: cap }, (_, i) => (i < 3 ? ['SPY', 'QQQ', 'GLD'][i] : `ZZ${i}`)),
      );
      mockDynamicSymbols(
        Array.from({ length: cap - 3 }, (_, i) => `ZZ${i + 3}`),
      );
      // Real shape: only the actual dynamic occupants (ZZ*) have a dynamic momentum score - a
      // shortlist symbol that was never streamed has none, exactly like getDynamicMomentumScore()
      // behaves for a real never-tracked symbol. A blanket 0.5-for-everything mock here would give
      // every shortlist symbol (not just IOVA) a positive challenger score, defeating the test.
      vi.spyOn(marketDataWorker, 'getDynamicMomentumScore').mockImplementation((s: string) => (s.startsWith('ZZ') ? 0.5 : null));
      // Momentum's own static universe has NOTHING today - isolates that IOVA wins purely via the
      // NEW broad-universe challenger path, not because it happened to also be in `top`.
      vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([]);
      vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockReturnValue(null);
      // SYNTHETIC test input, not an exact historical reproduction: admitted via the broad-universe
      // ADV screen, NOT in the momentum universe, with a gapPct in the same rough magnitude the
      // 2026-09-29 forensic audit's real IOVA case study reported (~+34% vs previous close - the
      // audit's own gapPct field is computed vs session open elsewhere in this codebase, so this
      // 0.34 stands in for "a real, large gap", not a literal replay of IOVA's own numbers).
      vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(['IOVA']));
      vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseGapPct').mockImplementation((s: string) => (s === 'IOVA' ? 0.34 : null));

      const subs: Array<{ symbol?: string; reason?: string }> = [];
      const onSub = (p: { symbol?: string; reason?: string }) => subs.push(p);
      eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);
      const stats = await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z')); // 10:00 ET, full 12/12
      eventBus.unsubscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);

      expect(stats.ideasEmitted).toBe(0); // still never a trade idea - discovery/subscribe only
      expect(stats.broadUniverseChallengers).toBe(1);
      expect(stats.broadUniverseHotSwapWinners).toBe(1);
      const iovaSub = subs.find((s) => s.symbol === 'IOVA');
      expect(iovaSub).toBeDefined();
      expect(iovaSub?.reason).toBe('BROAD_UNIVERSE_HOT_SWAP');
      // Still respects the same single-swap-per-cycle pacing - not a new capacity increase.
      expect(subs).toHaveLength(1);
      // SCOPE OF THIS TEST (2026-09-29 correction): this proves a real WATCHLIST_SUBSCRIBE_REQUESTED
      // event was emitted for IOVA at source-code level, in-process, with mocked MarketDataWorker/
      // SnapshotScanner/MarketUniverseScanner collaborators - it does NOT prove a real broker
      // subscription acknowledgment, a fresh live tick, or a real QuantSignalAgent assessment. See
      // the integration-style tests below (real-relevant-services coverage) for that further trace.
    });

    it('a broad-universe admission with zero real evidence (no gap, no mover-bonus, no composable score) never wins a hot-swap slot at full capacity - admission alone is not competitive evidence', async () => {
      process.env[FLAG_O] = 'true';
      const cap = continuousIntelligence.maxActiveSubscriptions;
      vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(
        Array.from({ length: cap }, (_, i) => (i < 3 ? ['SPY', 'QQQ', 'GLD'][i] : `ZZ${i}`)),
      );
      mockDynamicSymbols(
        Array.from({ length: cap - 3 }, (_, i) => `ZZ${i + 3}`),
      );
      vi.spyOn(marketDataWorker, 'getDynamicMomentumScore').mockImplementation((s: string) => (s.startsWith('ZZ') ? 0.5 : null));
      vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([]);
      vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockReturnValue(null);
      vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(['NOEVIDENCE']));
      vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseGapPct').mockReturnValue(null); // no gap evidence

      const subs: Array<{ symbol?: string }> = [];
      const onSub = (p: { symbol?: string }) => subs.push(p);
      eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);
      const stats = await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));
      eventBus.unsubscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);

      // Filtered out before ever becoming a challenger (momentumScore === 0) - never scored, never
      // occupies a swap slot, never emits a subscribe request.
      expect(stats.broadUniverseChallengers).toBe(0);
      expect(stats.broadUniverseHotSwapWinners).toBe(0);
      expect(subs.find((s) => s.symbol === 'NOEVIDENCE')).toBeUndefined();
    });

    it('respects broadUniverseHotSwapChallengerLimit - only the top-N broad-universe candidates by score are ever scored as challengers, bounding cost even with many admissions', async () => {
      process.env[FLAG_O] = 'true';
      const cap = continuousIntelligence.maxActiveSubscriptions;
      vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(
        Array.from({ length: cap }, (_, i) => (i < 3 ? ['SPY', 'QQQ', 'GLD'][i] : `ZZ${i}`)),
      );
      mockDynamicSymbols(
        Array.from({ length: cap - 3 }, (_, i) => `ZZ${i + 3}`),
      );
      vi.spyOn(marketDataWorker, 'getDynamicMomentumScore').mockImplementation((s: string) => (s.startsWith('ZZ') ? 0.5 : null));
      vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([]);
      vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockReturnValue(null);
      const originalLimit = continuousIntelligence.broadUniverseHotSwapChallengerLimit;
      (continuousIntelligence as any).broadUniverseHotSwapChallengerLimit = 3;
      try {
        const manySymbols = Array.from({ length: 10 }, (_, i) => `BU${i}`);
        vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(manySymbols));
        // Every one has real, distinct gap evidence - without the limit, all 10 would qualify.
        vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseGapPct').mockImplementation(
          (s: string) => 0.05 + (manySymbols.indexOf(s) * 0.01),
        );
        const stats = await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));
        expect(stats.broadUniverseChallengers).toBe(3);
      } finally {
        (continuousIntelligence as any).broadUniverseHotSwapChallengerLimit = originalLimit;
      }
    });

    describe('2026-09-29 correction (Codex review): global ranking by comparable score, not source/array-order', () => {
      function setupFullCapacity(scoreOfZZ = 0.5) {
        const cap = continuousIntelligence.maxActiveSubscriptions;
        vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(
          Array.from({ length: cap }, (_, i) => (i < 3 ? ['SPY', 'QQQ', 'GLD'][i] : `ZZ${i}`)),
        );
        mockDynamicSymbols(
          Array.from({ length: cap - 3 }, (_, i) => `ZZ${i + 3}`),
        );
        vi.spyOn(marketDataWorker, 'getDynamicMomentumScore').mockImplementation((s: string) => (s.startsWith('ZZ') ? scoreOfZZ : null));
      }

      it('a stronger broad-universe candidate wins the single swap slot over a weaker static-universe candidate present in the SAME cycle - real defect: unsorted combinedTop let array order (static-universe-first) decide instead of score', async () => {
        process.env[FLAG_O] = 'true';
        setupFullCapacity();
        // Weak static candidate: real momentumScore 1, barely above nothing.
        vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([
          { symbol: 'WEAK1', intradayPctChange: 1, rangeExpansion: 0, relativeVolume: 0, momentumScore: 1 },
        ]);
        vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockImplementation((s) => (s === 'WEAK1' ? 1 : null));
        // Strong broad-universe candidate: a real, large gap (SYNTHETIC input, not a literal
        // historical reproduction - see the IOVA-class test above for the same convention).
        vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(['BROAD']));
        vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseGapPct').mockImplementation((s: string) => (s === 'BROAD' ? 0.34 : null));

        const subs: Array<{ symbol?: string; reason?: string }> = [];
        const onSub = (p: { symbol?: string; reason?: string }) => subs.push(p);
        eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);
        await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));
        eventBus.unsubscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);

        // Only ONE slot is available this cycle (full capacity, momentumHotSwapSlotsPerCycle=1) -
        // the stronger real candidate must win it, regardless of which pool it came from or which
        // array position it occupied before sorting.
        expect(subs).toHaveLength(1);
        expect(subs[0].symbol).toBe('BROAD');
        expect(subs.find((s) => s.symbol === 'WEAK1')).toBeUndefined();
      });

      it('reverse ordering: the same outcome holds when the broad-universe candidate is scored first / listed after the static one in source data - ranking, not array position, decides', async () => {
        process.env[FLAG_O] = 'true';
        setupFullCapacity();
        vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([
          { symbol: 'AAAAA', intradayPctChange: 1, rangeExpansion: 0, relativeVolume: 0, momentumScore: 1 },
        ]);
        vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockImplementation((s) => (s === 'AAAAA' ? 1 : null));
        // 'AAAAA' < 'ZBROD' alphabetically and momentum-universe entries are placed first
        // in the raw (pre-sort) array either way - this test exists to prove the SORT (not
        // whatever the pre-sort array order happens to be) determines the winner.
        vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(['ZBROD']));
        vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseGapPct').mockImplementation((s: string) => (s === 'ZBROD' ? 0.5 : null));

        const subs: Array<{ symbol?: string }> = [];
        const onSub = (p: { symbol?: string }) => subs.push(p);
        eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);
        await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));
        eventBus.unsubscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);

        expect(subs).toHaveLength(1);
        expect(subs[0].symbol).toBe('ZBROD');
      });

      it('deterministic tie-break: two candidates with EXACTLY equal priority score resolve alphabetically by symbol, not by insertion order', async () => {
        process.env[FLAG_O] = 'true';
        setupFullCapacity();
        // Both candidates score identically: momentum's raw momentumScore vs broad-universe's
        // gap-derived score are set to the SAME value under the unified priorityScoreOf() formula
        // (base=0 for both since getDynamicMomentumScore/getLastSnapshotScore don't cover either,
        // gap term = |gapPct|*100*broadUniverseGapHotSwapWeight(0.5) = 0.20*100*0.5 = 10 for the
        // broad candidate; the static candidate's own momentumScore is set to the same 10 so both
        // sides of the merge tie exactly).
        vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([
          { symbol: 'ZEBRA', intradayPctChange: 10, rangeExpansion: 0, relativeVolume: 0, momentumScore: 10 },
        ]);
        vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockImplementation((s) => (s === 'ZEBRA' ? 10 : null));
        vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(['ALPHA']));
        vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseGapPct').mockImplementation((s: string) => (s === 'ALPHA' ? 0.20 : null));

        const subs: Array<{ symbol?: string }> = [];
        const onSub = (p: { symbol?: string }) => subs.push(p);
        eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);
        await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));
        eventBus.unsubscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);

        // 'ALPHA' < 'ZEBRA' alphabetically - the documented deterministic tiebreak (same score ->
        // symbol.localeCompare) must pick ALPHA, not whichever happened to be first in the array.
        expect(subs).toHaveLength(1);
        expect(subs[0].symbol).toBe('ALPHA');
      });

      it('score propagation: a broad-universe hot-swap winner\'s REAL priority score (not undefined/getLastSnapshotScore) is what gets emitted on WATCHLIST_SUBSCRIBE_REQUESTED, so MarketDataWorker.subscribe() actually seeds a real eviction-priority score instead of silently defaulting the symbol to 0', async () => {
        process.env[FLAG_O] = 'true';
        setupFullCapacity();
        vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([]);
        vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockReturnValue(null); // real shape: broad-only symbol has NO snapshot score
        vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(['WINNR']));
        vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseGapPct').mockImplementation((s: string) => (s === 'WINNR' ? 0.34 : null));

        const subs: Array<{ symbol?: string; momentumScore?: number }> = [];
        const onSub = (p: { symbol?: string; momentumScore?: number }) => subs.push(p);
        eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);
        await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));
        eventBus.unsubscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);

        const winner = subs.find((s) => s.symbol === 'WINNR');
        expect(winner).toBeDefined();
        // Real defect this closes: this used to be `undefined` (getLastSnapshotScore('WINNR')
        // is null for a broad-universe-only symbol) - MarketDataWorker.subscribe()'s
        // `typeof === 'number'` guard would then never seed dynamicMomentumScores, and the very next
        // pruneLeastActiveWatchSymbols() would rank this symbol as score 0, the worst possible value,
        // regardless of the real +34%-class gap evidence that won it the slot.
        expect(typeof winner!.momentumScore).toBe('number');
        expect(winner!.momentumScore).toBeGreaterThan(0);
      });
    });

    describe('2026-09-29 second correction (Codex review item 4): challenger/incumbent scoring symmetry and cross-cycle double-counting', () => {
      it('symmetry: an incumbent with real gap evidence but no snapshot/mover/composable base is correctly weighed against a challenger, not silently scored 0 by ignoring its own gap term', async () => {
        process.env[FLAG_O] = 'true';
        const cap = continuousIntelligence.maxActiveSubscriptions;
        // INCUM is an existing dynamic occupant with ZERO snapshot/mover/composable evidence but a
        // real, currently-cached broad-universe gap of 0.50 (gapTerm = 0.50*100*0.5 = 25 under the
        // real broadUniverseGapHotSwapWeight=0.5 default). Every OTHER occupant is a plain static
        // filler with no gap evidence at all, so INCUM is the only occupant whose real total
        // priority (25) depends on the gap term being counted at all.
        vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(
          Array.from({ length: cap }, (_, i) => (i < 3 ? ['SPY', 'QQQ', 'GLD'][i] : (i === 3 ? 'INCUM' : `ZZ${i}`))),
        );
        mockDynamicSymbols(
          Array.from({ length: cap - 3 }, (_, i) => (i === 0 ? 'INCUM' : `ZZ${i + 3}`)),
        );
        vi.spyOn(marketDataWorker, 'getDynamicMomentumScore').mockReturnValue(null); // unused by baseScoreOf post-fix; irrelevant here
        vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([
          // CHALL: a real but modest momentum-universe challenger, no gap evidence of its own.
          { symbol: 'CHALL', intradayPctChange: 2, rangeExpansion: 0, relativeVolume: 0, momentumScore: 10 },
        ]);
        // baseScoreOf is now sourced ONLY from getLastSnapshotScore (never getDynamicMomentumScore -
        // that fallback is exactly what this correction removed). The ZZ* incumbents need a real,
        // fresh snapshot score of their own here so INCUM (score 25, from gap alone) is correctly
        // NOT the weakest active dynamic symbol relative to CHALL (10) - isolating this test to the
        // one real question: does INCUM's own gap evidence count toward ITS OWN eviction-ranking
        // score at all (symmetry), not which of several occupants happens to be weakest overall.
        vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockImplementation((s: string) => {
          if (s === 'CHALL') return 10;
          if (s.startsWith('ZZ')) return 50;
          return null; // INCUM: no snapshot presence - relies purely on its own gap term
        });
        vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue([]);
        vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseGapPct').mockImplementation((s: string) => (s === 'INCUM' ? 0.50 : null));

        const subs: Array<{ symbol?: string }> = [];
        const onSub = (p: { symbol?: string }) => subs.push(p);
        eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);
        await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));
        eventBus.unsubscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);

        // INCUM's real total priority (25, from its own gap term) exceeds CHALL's (10) by more than
        // scoreEdge - INCUM must survive and CHALL must NOT win the single swap slot. Under the
        // prior asymmetric scoreOf (blendedHotSwapScore alone, no gap term), INCUM would have been
        // ranked as the weakest active dynamic symbol (score 0, its gap evidence silently excluded)
        // and CHALL's mere 10 would have cleared the scoreEdge and wrongly evicted it.
        expect(subs.find((s) => s.symbol === 'CHALL')).toBeUndefined();
      });

      it('no cross-cycle double-counting: a broad-universe winner\'s propagated score stays the SAME real value once it becomes an incumbent, so a later cycle cannot compound mover/composable/gap bonuses on top of its own already-bonused stored score', async () => {
        process.env[FLAG_O] = 'true';
        const cap = continuousIntelligence.maxActiveSubscriptions;

        // ---- Cycle 1: BROAD wins a hot-swap slot purely on gap evidence (0.34 -> gapTerm 17,
        // base=0, no mover, no composable) against a weak static candidate. ----
        vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(
          Array.from({ length: cap }, (_, i) => (i < 3 ? ['SPY', 'QQQ', 'GLD'][i] : `ZZ${i}`)),
        );
        mockDynamicSymbols(
          Array.from({ length: cap - 3 }, (_, i) => `ZZ${i + 3}`),
        );
        vi.spyOn(marketDataWorker, 'getDynamicMomentumScore').mockReturnValue(null); // unused by baseScoreOf post-fix
        vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([]);
        // Weak/no-evidence ZZ* fillers (base 0, same shape as the IOVA-class test above) so BROAD's
        // own real gap-only evidence (17) is enough to win this cycle's single swap slot.
        vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockReturnValue(null);
        vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(['BROAD']));
        vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseGapPct').mockImplementation((s: string) => (s === 'BROAD' ? 0.34 : null));

        const cycle1Subs: Array<{ symbol?: string; momentumScore?: number }> = [];
        const onSub1 = (p: { symbol?: string; momentumScore?: number }) => cycle1Subs.push(p);
        eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub1);
        await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));
        eventBus.unsubscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub1);

        const broadWin = cycle1Subs.find((s) => s.symbol === 'BROAD');
        expect(broadWin).toBeDefined();
        const broadCycle1Score = broadWin!.momentumScore!;
        expect(broadCycle1Score).toBeCloseTo(17, 5); // 0.34 * 100 * broadUniverseGapHotSwapWeight(0.5)

        // ---- Cycle 2: BROAD is now a real incumbent (as MarketDataWorker.subscribe() would have
        // made it after cycle 1 - simulated here by including it in getDynamicSymbols/getActiveSymbols
        // and mocking getDynamicMomentumScore('BROAD') to return EXACTLY the score cycle 1 propagated,
        // the real shape of what the stored dynamicMomentumScores map would hold). Gap conditions for
        // BROAD are unchanged (still 0.34) - a real symbol whose evidence hasn't grown. A genuinely
        // STRONGER new challenger (gap 0.60 -> gapTerm 30) competes for the single swap slot. ----
        resetOpportunityScanForTests();
        SnapshotScanner.resetSnapshotScannerForTests();
        resetBroadUniverseAllocatorForTests();
        vi.restoreAllMocks();
        vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(
          Array.from({ length: cap }, (_, i) => (i < 3 ? ['SPY', 'QQQ', 'GLD'][i] : (i === 3 ? 'BROAD' : `ZZ${i}`))),
        );
        mockDynamicSymbols(
          Array.from({ length: cap - 3 }, (_, i) => (i === 0 ? 'BROAD' : `ZZ${i + 3}`)),
        );
        // Real shape of what MarketDataWorker.subscribe() would have stored after cycle 1: BROAD's
        // own dynamicMomentumScores entry equals exactly what cycle 1 propagated. This mock exists so
        // the OLD, now-removed baseScoreOf fallback (`?? marketDataWorker.getDynamicMomentumScore(s)`)
        // would have read it back and compounded on top - the fixed baseScoreOf never calls this
        // method at all, so this mock is deliberately a trap for regression, not a dependency of the
        // current code path.
        vi.spyOn(marketDataWorker, 'getDynamicMomentumScore').mockImplementation(
          (s: string) => (s === 'BROAD' ? broadCycle1Score : null),
        );
        vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([]);
        // ZZ* fillers now get a real, strong snapshot base (50, comfortably above BROAD's correct 17
        // AND its buggy-compounded 34) so BROAD - not a ZZ filler - is deterministically the weakest
        // active dynamic symbol under EITHER the fixed or the (hypothetical, removed) buggy scoring.
        // This isolates the assertion below to exactly one question: does STRONG's real 30 clear
        // BROAD's real eviction-ranking score, whatever that score is computed to be.
        vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockImplementation((s: string) => (s.startsWith('ZZ') ? 50 : null));
        vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(['STRNG']));
        vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseGapPct').mockImplementation((s: string) => {
          if (s === 'STRNG') return 0.60;
          if (s === 'BROAD') return 0.34; // unchanged real evidence, not re-fetched as "new"
          return null;
        });

        const cycle2Subs: Array<{ symbol?: string; reason?: string }> = [];
        const onSub2 = (p: { symbol?: string; reason?: string }) => cycle2Subs.push(p);
        eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub2);
        await runOpportunityScan(new Date('2026-08-21T14:05:00.000Z'));
        eventBus.unsubscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub2);

        // STRNG (real fresh gapTerm 30) must win the slot over BROAD's real, unchanged, NON-
        // COMPOUNDED evidence (17) - the fix this test guards. Under the removed buggy fallback,
        // BROAD's cycle-2 "base" would have read back its own cycle-1 final score (17) and added a
        // second gap term on top (17 + 17 = 34), which would have out-scored STRNG's 30 and
        // wrongly kept BROAD in place forever, compounding on every subsequent cycle.
        expect(cycle2Subs.find((s) => s.symbol === 'STRNG')).toBeDefined();
      });
    });
  });

  it('2026-09-16 regression: the broad-universe top-up never runs when momentum rotation already filled every empty slot', async () => {
    process.env[FLAG_O] = 'true';
    const cap = continuousIntelligence.maxActiveSubscriptions;
    vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(
      Array.from({ length: cap }, (_, i) => (i < 3 ? ['SPY', 'QQQ', 'GLD'][i] : `ZZ${i}`)),
    );
    mockDynamicSymbols(
      Array.from({ length: cap - 3 }, (_, i) => `ZZ${i + 3}`),
    );
    vi.spyOn(marketDataWorker, 'getDynamicMomentumScore').mockReturnValue(0.5);
    vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([
      { symbol: 'AMD', intradayPctChange: 6, rangeExpansion: 0.02, relativeVolume: 2.5, momentumScore: 6 },
    ]);
    vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockImplementation((s) => (s === 'AMD' ? 6 : null));
    vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(['AMZN']));

    const subs: Array<{ symbol?: string; reason?: string }> = [];
    const onSub = (p: { symbol?: string; reason?: string }) => subs.push(p);
    eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);
    await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));
    eventBus.unsubscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);

    expect(subs).toHaveLength(1); // only the single hot-swap slot, no top-up capacity to spend
    expect(subs[0].symbol).toBe('AMD');
  });
});

/**
 * 2026-09-30 (Discovery Challenger Observability Hardening,
 * ARGUS_CHALLENGER_SELECTION_FORENSIC_2026-09-29.md follow-up). Observability-only additions to
 * OpportunityDiscovery's per-cycle hot-swap planning: a bounded pre-truncation challenger-pool
 * snapshot, a canonical reasonCode on the existing per-decision explainer output, and swap-budget
 * state. None of these change broadUniverseHotSwapChallengerLimit, momentumHotSwapSlotsPerCycle,
 * priorityScoreOf(), admission thresholds, subscription capacity, or protection - every test in this
 * block asserts the REAL subscribe outcome is identical to the un-observed baseline (proven directly
 * in the "logging cannot alter selection" and "ordering/ranking unaffected" tests), and that the new
 * structured events carry real, non-fabricated values already used by the real decision.
 */
describe('OpportunityDiscovery observability hardening (2026-09-30)', () => {
  function setupFullCapacity(scoreOfZZ = 0.5) {
    const cap = continuousIntelligence.maxActiveSubscriptions;
    vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(
      Array.from({ length: cap }, (_, i) => (i < 3 ? ['SPY', 'QQQ', 'GLD'][i] : `ZZ${i}`)),
    );
    mockDynamicSymbols(
      Array.from({ length: cap - 3 }, (_, i) => `ZZ${i + 3}`),
    );
    vi.spyOn(marketDataWorker, 'getDynamicMomentumScore').mockImplementation((s: string) => (s.startsWith('ZZ') ? scoreOfZZ : null));
  }

  it('a candidate with null gap data and no other evidence logs the exact zero-score exclusion cause, and is never individually named in the bounded candidate detail', async () => {
    process.env[FLAG_O] = 'true';
    setupFullCapacity();
    vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([]);
    vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockReturnValue(null);
    vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(['NOEVD']));
    vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseGapPct').mockReturnValue(null); // no gap evidence anywhere

    const logSpy = vi.spyOn(structuredLogger, 'info');
    await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));

    const snapshotCall = logSpy.mock.calls.find((c) => c[1]?.eventType === 'DISCOVERY_CHALLENGER_CYCLE_SNAPSHOT');
    expect(snapshotCall).toBeTruthy();
    const fields = snapshotCall![1] as Record<string, unknown>;
    expect(fields.zeroScoreOrExcludedCount as number).toBeGreaterThanOrEqual(1);
    const candidates = fields.candidates as Array<Record<string, unknown>>;
    expect(candidates.find((c) => c.symbol === 'NOEVD')).toBeUndefined(); // zero-score, excluded before the eligible list
  });

  // 2026-10-05 (Challenger Exclusion & Aging forensic follow-up): the BROAD_UNIVERSE_CHALLENGER_EXCLUDED
  // event's own comment claimed its bounded 25-entry sample was "top 25 by absolute gap", but no sort
  // ever ran before the slice - confirmed as a real bug by this exact test failing before the fix (dozens
  // of real seed/watch-universe symbols tie at baseScore=0/gapPct=null in this fixture and, in
  // shortlist's own concatenation order, always won the bound ahead of the one broad-universe-sourced
  // symbol this event exists to surface).
  it('BROAD_UNIVERSE_CHALLENGER_EXCLUDED surfaces a broad-universe-sourced exclusion in its bounded sample even when many static seed/watch symbols also tie at zero score', async () => {
    process.env[FLAG_O] = 'true';
    setupFullCapacity();
    vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([]);
    vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockReturnValue(null); // every static symbol ties at baseScore=0
    vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(['BUNEV']));
    vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseGapPct').mockReturnValue(null);

    const logSpy = vi.spyOn(structuredLogger, 'info');
    await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));

    const excludedCall = logSpy.mock.calls.find((c) => c[1]?.eventType === 'BROAD_UNIVERSE_CHALLENGER_EXCLUDED');
    expect(excludedCall).toBeTruthy();
    const sample = (excludedCall![1] as any).excluded as Array<Record<string, unknown>>;
    expect(sample.find((c) => c.symbol === 'BUNEV')).toBeTruthy();
  });

  // Documents a real dead-code/comment-mismatch finding: classifyExclusionReason() has an
  // INFINITE_SCORE branch and a dedicated unit test asserting it (challengerExclusionReason.test.ts),
  // but the real pipeline's own eligibility filter (`finalScore > 0`) is true for Infinity, so an
  // Infinite-score candidate never enters zeroScoreExcluded and this classifier is never actually
  // called with one in production - it is promoted, not excluded, exactly like a normal winner. This
  // end-to-end test proves that directly rather than only asserting the classifier's isolated,
  // unreachable-in-practice behavior. Not fixed here - patching it would change real scoring/
  // selection behavior, which an observability-only pass should not do silently.
  it('[DOCUMENTS DEAD CODE] an Infinite base score is promoted, not excluded - classifyExclusionReason("INFINITE_SCORE") is never reached by the real pipeline', async () => {
    process.env[FLAG_O] = 'true';
    setupFullCapacity();
    vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([]);
    vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockImplementation((s: string) => (s === 'INFSC' ? Infinity : null));
    vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(['INFSC']));
    vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseGapPct').mockReturnValue(null);

    const subs: Array<{ symbol?: string }> = [];
    const onSub = (p: { symbol?: string }) => subs.push(p);
    eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);
    const logSpy = vi.spyOn(structuredLogger, 'info');
    await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));
    eventBus.unsubscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);

    expect(subs.find((s) => s.symbol === 'INFSC')).toBeTruthy(); // promoted, not excluded
    const excludedCall = logSpy.mock.calls.find((c) => c[1]?.eventType === 'BROAD_UNIVERSE_CHALLENGER_EXCLUDED');
    const sample = (excludedCall?.[1] as any)?.excluded as Array<Record<string, unknown>> | undefined;
    expect(sample?.find((c) => c.symbol === 'INFSC')).toBeUndefined(); // never excluded, so never reason-coded either
  });

  it('a positive-score candidate ranked outside the challenger limit logs BELOW_CHALLENGER_LIMIT truncation via survivedTruncation:false, with its real rank and score recorded', async () => {
    process.env[FLAG_O] = 'true';
    setupFullCapacity();
    vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([]);
    vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockReturnValue(null);
    const originalLimit = continuousIntelligence.broadUniverseHotSwapChallengerLimit;
    (continuousIntelligence as any).broadUniverseHotSwapChallengerLimit = 3;
    try {
      // looksLikeListedTicker() requires ^[A-Z]{1,5}(\.[A-Z])?$ - no digits, max 5 letters (the
      // pre-existing 'BU0'..'BU9' convention elsewhere in this file relies on those symbols being
      // REJECTED as invalid tickers before ever reaching challenger scoring, which happens to leave
      // its own assertions passing for the wrong reason - see this task's own investigation. These
      // are real, valid-shaped tickers so the real admission/scoring path is genuinely exercised.
      const manySymbols = ['BUAAA', 'BUBBB', 'BUCCC', 'BUDDD', 'BUEEE', 'BUFFF'];
      vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(manySymbols));
      // Distinct, strictly increasing real gap evidence - BUFFF scores highest, BUAAA lowest. null
      // for every other symbol (the rest of the real scan universe) - a real gap only exists for
      // these 6, never a synthetic bonus for unrelated seed/watch symbols.
      vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseGapPct').mockImplementation(
        (s: string) => (manySymbols.includes(s) ? 0.05 + (manySymbols.indexOf(s) * 0.01) : null),
      );
      const logSpy = vi.spyOn(structuredLogger, 'info');
      await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));

      const snapshotCall = logSpy.mock.calls.find((c) => c[1]?.eventType === 'DISCOVERY_CHALLENGER_CYCLE_SNAPSHOT');
      expect(snapshotCall).toBeTruthy();
      const fields = snapshotCall![1] as Record<string, unknown>;
      expect(fields.survivedTruncationCount).toBe(3);
      const candidates = fields.candidates as Array<Record<string, unknown>>;
      // BUAAA is the weakest of the 6 - real rank 6, truncated out of the top-3 challenger limit.
      const weakest = candidates.find((c) => c.symbol === 'BUAAA');
      expect(weakest).toBeTruthy();
      expect(weakest!.survivedTruncation).toBe(false);
      expect(weakest!.rankBeforeTruncation).toBe(6);
      // BUFFF is the strongest - real rank 1, survives truncation.
      const strongest = candidates.find((c) => c.symbol === 'BUFFF');
      expect(strongest!.survivedTruncation).toBe(true);
      expect(strongest!.rankBeforeTruncation).toBe(1);
    } finally {
      (continuousIntelligence as any).broadUniverseHotSwapChallengerLimit = originalLimit;
    }
  });

  it('a candidate that survives truncation but arrives after the single-swap-per-cycle budget is consumed logs SWAP_CAP_REACHED, and the promoted candidate logs its displaced incumbent', async () => {
    process.env[FLAG_O] = 'true';
    setupFullCapacity();
    vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([]);
    vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockReturnValue(null);
    // Two real challengers, both well inside the default challenger limit (15) - only ONE can be
    // promoted this cycle (momentumHotSwapSlotsPerCycle=1 at full capacity).
    vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(['STRNG', 'RUNUP']));
    vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseGapPct').mockImplementation((s: string) => {
      if (s === 'STRNG') return 0.50;
      if (s === 'RUNUP') return 0.40;
      return null;
    });

    const logSpy = vi.spyOn(structuredLogger, 'info');
    const subs: Array<{ symbol?: string }> = [];
    const onSub = (p: { symbol?: string }) => subs.push(p);
    eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);
    await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));
    eventBus.unsubscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);

    // Real decision unchanged: only the stronger candidate is actually requested.
    expect(subs).toHaveLength(1);
    expect(subs[0].symbol).toBe('STRNG');

    const decisionCalls = logSpy.mock.calls.filter((c) => c[0] === 'subscription_priority_decision');
    const strongDecision = decisionCalls.find((c) => c[1]?.symbol === 'STRNG');
    const runnerUpDecision = decisionCalls.find((c) => c[1]?.symbol === 'RUNUP');
    expect(strongDecision![1].eventType).toBe('SUBSCRIPTION_PROMOTED');
    expect(strongDecision![1].reasonCode).toBe('CHALLENGER_SELECTED');
    expect(strongDecision![1].promotedSymbol).toBe('STRNG');
    expect(typeof strongDecision![1].displacedSymbol).toBe('string');
    expect(typeof strongDecision![1].incumbentScore).toBe('number');
    expect(runnerUpDecision![1].eventType).toBe('SUBSCRIPTION_NOT_PROMOTED');
    expect(runnerUpDecision![1].reasonCode).toBe('SWAP_CAP_REACHED');
  });

  it('a logger failure cannot alter the real hot-swap selection - the real subscribe request still fires identically', async () => {
    process.env[FLAG_O] = 'true';
    setupFullCapacity();
    vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([]);
    vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockReturnValue(null);
    vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(['RESIL']));
    vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseGapPct').mockImplementation((s: string) => (s === 'RESIL' ? 0.34 : null));
    // Every structured-log call throws - observeSafe() must swallow it, never propagate into the
    // real decision path.
    vi.spyOn(structuredLogger, 'info').mockImplementation(() => { throw new Error('logger unavailable'); });

    const subs: Array<{ symbol?: string }> = [];
    const onSub = (p: { symbol?: string }) => subs.push(p);
    eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);
    const stats = await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));
    eventBus.unsubscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);

    expect(subs).toHaveLength(1);
    expect(subs[0].symbol).toBe('RESIL');
    expect(stats.broadUniverseHotSwapWinners).toBe(1);
  });

  it('the new observability calls do not affect ordering/ranking - the same scenario produces an identical real winner whether or not the logger is spied on', async () => {
    process.env[FLAG_O] = 'true';
    async function runScenario() {
      resetOpportunityScanForTests();
      SnapshotScanner.resetSnapshotScannerForTests();
      resetBroadUniverseAllocatorForTests();
      process.env[FLAG_O] = 'true';
      setupFullCapacity();
      vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([]);
      vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockReturnValue(null);
      vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(['STABL', 'WEAKR']));
      vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseGapPct').mockImplementation((s: string) => {
        if (s === 'STABL') return 0.45;
        if (s === 'WEAKR') return 0.10;
        return null;
      });
      const subs: Array<{ symbol?: string }> = [];
      const onSub = (p: { symbol?: string }) => subs.push(p);
      eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);
      await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));
      eventBus.unsubscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);
      return subs.map((s) => s.symbol);
    }

    const withoutSpy = await runScenario();
    vi.restoreAllMocks();
    const logSpy = vi.spyOn(structuredLogger, 'info');
    const withSpy = await runScenario();
    expect(logSpy.mock.calls.length).toBeGreaterThan(0); // real logging did happen this time
    expect(withSpy).toEqual(withoutSpy); // identical real outcome either way
    expect(withSpy).toEqual(['STABL']);
  });
});

/**
 * Phase 3 (Dynamic Market Data Allocation, 2026-09-02 forensic-audit follow-up):
 * blendedHotSwapScore() combines SnapshotScanner's own momentum score with the SEPARATE, real
 * external mover signal MarketUniverseScanner's movers funnel already computes - two real
 * discovery mechanisms that previously never talked to each other for subscription-priority
 * purposes. Uses the real refreshMoversCache()/getCachedMoverSymbols() pair (mocked Alpaca fetch
 * only, same pattern as MarketUniverseScanner.test.ts), never a fabricated mover list.
 */
describe('OpportunityDiscovery.blendedHotSwapScore - Phase 3 Dynamic Market Data Allocation', () => {
  const MOVERS_FLAG = continuousIntelligence.moversEnabledEnvVar;

  afterEach(async () => {
    delete process.env[MOVERS_FLAG];
    const { resetMarketUniverseScannerForTests } = await import('./MarketUniverseScanner');
    resetMarketUniverseScannerForTests();
    vi.restoreAllMocks();
  });

  it('gives a real, currently-cached Alpaca mover an additive priority bonus over an equally-scored non-mover', async () => {
    process.env[MOVERS_FLAG] = 'true';
    const realAlpacaTls = await import('../core/alpacaTls');
    vi.spyOn(realAlpacaTls, 'alpacaFetch').mockImplementation(async (url: string) => {
      if (url.includes('/movers')) {
        return {
          ok: true, status: 200, headers: { get: () => null },
          json: async () => ({
            gainers: [{ symbol: 'REALMOVER', price: 80, change: 5, percent_change: 12 }],
            losers: [],
          }),
        } as any;
      }
      if (url.includes('/snapshots')) {
        return {
          ok: true, status: 200, headers: { get: () => null },
          json: async () => ({ REALMOVER: { latestTrade: { p: 80 }, dailyBar: { v: 2_000_000, c: 80 }, latestQuote: { bp: 79.9, ap: 80.1 } } }),
        } as any;
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ bars: { REALMOVER: liquidCompletedBars() } }) } as any;
    });

    const { refreshMoversCache } = await import('./MarketUniverseScanner');
    await refreshMoversCache();

    const baseScoreOf = () => 1.0; // both symbols have an identical underlying momentum score
    const moverScore = blendedHotSwapScore('REALMOVER', baseScoreOf);
    const nonMoverScore = blendedHotSwapScore('SOMEOTHERSYMBOL', baseScoreOf);
    expect(moverScore).toBeGreaterThan(nonMoverScore);
    expect(moverScore).toBeCloseTo(1.0 + continuousIntelligence.moverPriorityScoreBonus);
    expect(nonMoverScore).toBe(1.0);
  });

  it('when the movers flag is off (or nothing is cached), the bonus never applies - identical to the pre-Phase-3 score', () => {
    const baseScoreOf = () => 0.7;
    expect(blendedHotSwapScore('ANYSYMBOL', baseScoreOf)).toBe(0.7);
  });
});

/**
 * Universal Opportunity Discovery follow-up (2026-09-03): blendedHotSwapScore() also blends in
 * ComposableRanking's persisted finalScore (getLastComposableScore()) - the real gap this closes
 * is that runRankingCycle()'s 7-component, evidence-aware score (gap/liquidity/newsCatalyst/
 * agentConfidence, not just raw momentum) previously had zero influence on subscription/eviction
 * decisions; it only ever fed TradePlanBuilder and MissedOpportunityDetector.
 */
describe('OpportunityDiscovery.blendedHotSwapScore - composable-ranking wiring', () => {
  afterEach(() => {
    SnapshotScanner.resetSnapshotScannerForTests();
    vi.restoreAllMocks();
  });

  it('gives a symbol with a strong composable finalScore an additive bonus over an equally-momentum-scored symbol with no composable score', () => {
    vi.spyOn(SnapshotScanner, 'getLastComposableScore').mockImplementation((s: string) =>
      s === 'STRONGEVIDENCE' ? 0.9 : null);
    const baseScoreOf = () => 1.0;
    const withEvidence = blendedHotSwapScore('STRONGEVIDENCE', baseScoreOf);
    const withoutEvidence = blendedHotSwapScore('NOEVIDENCE', baseScoreOf);
    expect(withEvidence).toBeGreaterThan(withoutEvidence);
    expect(withEvidence).toBeCloseTo(1.0 + (0.9 * continuousIntelligence.composableRankingHotSwapWeight));
    expect(withoutEvidence).toBe(1.0);
  });

  it('never fabricates a composable bonus when no ranking cycle has produced a score for this symbol yet', () => {
    vi.spyOn(SnapshotScanner, 'getLastComposableScore').mockReturnValue(null);
    const baseScoreOf = () => 0.42;
    expect(blendedHotSwapScore('UNSCANNED', baseScoreOf)).toBe(0.42);
  });

  it('composable bonus and mover bonus stack additively when both apply', async () => {
    const MOVERS_FLAG = continuousIntelligence.moversEnabledEnvVar;
    process.env[MOVERS_FLAG] = 'true';
    const realAlpacaTls = await import('../core/alpacaTls');
    vi.spyOn(realAlpacaTls, 'alpacaFetch').mockImplementation(async (url: string) => {
      if (url.includes('/movers')) {
        return {
          ok: true, status: 200, headers: { get: () => null },
          json: async () => ({
            gainers: [{ symbol: 'DOUBLEBOOST', price: 80, change: 5, percent_change: 12 }],
            losers: [],
          }),
        } as any;
      }
      if (url.includes('/snapshots')) {
        return {
          ok: true, status: 200, headers: { get: () => null },
          json: async () => ({ DOUBLEBOOST: { latestTrade: { p: 80 }, dailyBar: { v: 2_000_000, c: 80 }, latestQuote: { bp: 79.9, ap: 80.1 } } }),
        } as any;
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ bars: { DOUBLEBOOST: liquidCompletedBars() } }) } as any;
    });

    const { refreshMoversCache } = await import('./MarketUniverseScanner');
    await refreshMoversCache();
    vi.spyOn(SnapshotScanner, 'getLastComposableScore').mockImplementation((s: string) =>
      s === 'DOUBLEBOOST' ? 0.5 : null);

    const baseScoreOf = () => 1.0;
    const score = blendedHotSwapScore('DOUBLEBOOST', baseScoreOf);
    expect(score).toBeCloseTo(
      1.0 + continuousIntelligence.moverPriorityScoreBonus + (0.5 * continuousIntelligence.composableRankingHotSwapWeight),
    );

    delete process.env[MOVERS_FLAG];
    const { resetMarketUniverseScannerForTests } = await import('./MarketUniverseScanner');
    resetMarketUniverseScannerForTests();
  });
});
