/**
 * 2026-09-16 overnight certification follow-up to the BROAD_UNIVERSE_TOPUP fix
 * (OpportunityDiscovery.test.ts's own regression tests prove the fix's basic correctness; this
 * file stress-tests it at the scale a real post-SIP-fix broad universe actually produces -
 * hundreds of admitted symbols, not a handful - and exercises the adversarial edge cases named in
 * the overnight certification mandate: capacity exhaustion, duplicate symbols across sources,
 * momentum-vs-broad-universe interaction at every relative size, and determinism).
 *
 * Deliberately function-level, not a full synthetic session. The isolated Synthetic Market Session
 * Simulator (src/server/replay/synthetic/) calls marketDataWorker.subscribe() directly for its own
 * fixed universe and does NOT exercise OpportunityDiscovery's real scan at all - by design,
 * OpportunityDiscovery's real broad-universe/FMP/Alpaca calls are forced off inside that isolated
 * environment specifically to prevent a synthetic run from making real external API calls (see
 * ARGUS_ARCHITECTURE.md's Synthetic Market Session Simulator section). Testing the actual admission
 * -> subscription decision function directly, at real scale, is the correct, isolation-respecting
 * way to certify this specific fix - not a compromise.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { continuousIntelligence } from '../config/continuousIntelligence';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { marketDataWorker } from '../services/MarketDataWorker';
import { runOpportunityScan, resetOpportunityScanForTests, planSnapshotHotSwap } from './OpportunityDiscovery';
import * as SnapshotScanner from './SnapshotScanner';
import * as MarketUniverseScanner from './MarketUniverseScanner';
import { resetBroadUniverseAllocatorForTests } from './BroadUniverseSubscriptionAllocator';

const FLAG_O = continuousIntelligence.opportunityLoopEnabledEnvVar;

/** getCachedBroadUniverseCandidatesWithVolume() shape - descending dollar volume in array order. */
function withVolume(symbols: string[], startingVolume = 100_000_000): { symbol: string; dollarVolume: number }[] {
  return symbols.map((symbol, i) => ({ symbol, dollarVolume: startingVolume - i * 1000 }));
}

/** looksLikeListedTicker() requires 1-5 letters only (no digits) - generate realistic-looking,
 *  unique, letter-only synthetic tickers rather than an alphanumeric scheme that would be silently
 *  rejected by evaluateOpportunityCandidate() before ever reaching the subscription logic under
 *  test (caught live while building this file - digit-suffixed symbols produced an empty
 *  shortlist, not a production bug). */
function makeSymbols(seedLetter: string, n: number): string[] {
  // Single leading letter + up to 4 more (26^4 = 456,976 combinations) keeps every generated
  // ticker within looksLikeListedTicker()'s 5-letter cap regardless of how long a caller's label
  // string is.
  const lead = seedLetter.trim().toUpperCase().charAt(0) || 'X';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = alphabet[Math.floor(i / (alphabet.length * alphabet.length * alphabet.length)) % alphabet.length];
    const b = alphabet[Math.floor(i / (alphabet.length * alphabet.length)) % alphabet.length];
    const c = alphabet[Math.floor(i / alphabet.length) % alphabet.length];
    const d = alphabet[i % alphabet.length];
    out.push(`${lead}${a}${b}${c}${d}`);
  }
  return out;
}

/** Mirrors the real production isolation pattern used in the fix's own regression test: empty the
 *  static momentum universe so results are attributable to a single source under test. */
async function withEmptyMomentumStaticLists<T>(fn: () => Promise<T> | T): Promise<T> {
  const originalSeed = continuousIntelligence.seedSymbols;
  const originalWatch = continuousIntelligence.watchUniverseSymbols;
  const originalMomentumScan = continuousIntelligence.momentumScanUniverseSymbols;
  (continuousIntelligence as any).seedSymbols = [];
  (continuousIntelligence as any).watchUniverseSymbols = [];
  (continuousIntelligence as any).momentumScanUniverseSymbols = [];
  // getOpportunityScanUniverse() also folds in the movers/news-catalyst caches (separate,
  // independently-populated module state within MarketUniverseScanner.ts, not reset by
  // resetOpportunityScanForTests()/resetSnapshotScannerForTests()) - mock them empty too so
  // `shortlist` composition in these isolation-sensitive assertions is fully controlled.
  vi.spyOn(MarketUniverseScanner, 'getCachedMoverSymbols').mockReturnValue([]);
  vi.spyOn(MarketUniverseScanner, 'getCachedNewsCatalystSymbols').mockReturnValue([]);
  try {
    // Critical: must await here, not `return fn()` - fn is async, and a bare `return fn()` inside
    // a sync try/finally lets `finally` restore the real symbol lists before the async body (which
    // hasn't reached its first real assertion yet) actually finishes - a real bug caught live
    // while building this file (the first version of this helper silently restored seedSymbols
    // etc. before runOpportunityScan ever read them, leaking real production default symbols into
    // every "empty universe" assertion below).
    return await fn();
  } finally {
    (continuousIntelligence as any).seedSymbols = originalSeed;
    (continuousIntelligence as any).watchUniverseSymbols = originalWatch;
    (continuousIntelligence as any).momentumScanUniverseSymbols = originalMomentumScan;
  }
}

afterEach(() => {
  delete process.env[FLAG_O];
  resetOpportunityScanForTests();
  SnapshotScanner.resetSnapshotScannerForTests();
  resetBroadUniverseAllocatorForTests();
  vi.restoreAllMocks();
});

describe('OpportunityDiscovery scale/adversarial certification (post-SIP-fix, 2026-09-16)', () => {
  it('a broad universe of 1,000 ADV-admitted symbols (realistic post-SIP-fix scale) never requests more than the real per-cycle cap - bounded, no runaway, no hang', async () => {
    await withEmptyMomentumStaticLists(async () => {
      process.env[FLAG_O] = 'true';
      vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(['SPY', 'QQQ', 'GLD']);
      vi.spyOn(marketDataWorker, 'getDynamicSymbols').mockReturnValue([]);
      vi.spyOn(marketDataWorker, 'getDynamicMomentumScore').mockReturnValue(0);
      // A genuinely large, artificial cap so emptySlots isn't the binding constraint - proves the
      // real binding constraint is maxNewSubscriptionsPerCycle, not an accidental unbounded fill.
      vi.spyOn(marketDataWorker, 'getEffectiveStreamingCap').mockReturnValue(5000);
      vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([]);
      vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(makeSymbols('BU', 1000)));

      const subs: string[] = [];
      const seen = new Set<string>();
      let duplicateEmitted = false;
      const onSub = (p: { symbol?: string }) => {
        if (p.symbol) {
          if (seen.has(p.symbol)) duplicateEmitted = true;
          seen.add(p.symbol);
          subs.push(p.symbol);
        }
      };
      eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);
      const t0 = Date.now();
      const stats = await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));
      const elapsedMs = Date.now() - t0;
      eventBus.unsubscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);

      expect(stats.ideasEmitted).toBe(0);
      expect(subs.length).toBeLessThanOrEqual(continuousIntelligence.maxNewSubscriptionsPerCycle);
      expect(subs.length).toBeGreaterThan(0); // real capacity existed, must not sit idle
      expect(duplicateEmitted).toBe(false);
      expect(elapsedMs).toBeLessThan(5000); // no pathological scan against a 1,000-symbol universe
    });
  });

  it('duplicate symbols across the broad-universe list and momentum picks are requested exactly once, never twice', async () => {
    await withEmptyMomentumStaticLists(async () => {
      process.env[FLAG_O] = 'true';
      vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(['SPY', 'QQQ', 'GLD']);
      vi.spyOn(marketDataWorker, 'getDynamicSymbols').mockReturnValue([]);
      vi.spyOn(marketDataWorker, 'getDynamicMomentumScore').mockReturnValue(0);
      vi.spyOn(marketDataWorker, 'getEffectiveStreamingCap').mockReturnValue(50);
      // AMD appears in BOTH momentum's own picks AND the broad-universe admission list - a real,
      // plausible overlap (a stock can legitimately be both momentum-ranked and ADV-admitted).
      vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([
        { symbol: 'AMD', intradayPctChange: 3, rangeExpansion: 0.01, relativeVolume: 2, momentumScore: 5 },
      ]);
      vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockImplementation((s) => (s === 'AMD' ? 5 : null));
      vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(['AMD', 'AMZN', 'AVGO']));

      const subs: string[] = [];
      const onSub = (p: { symbol?: string }) => { if (p.symbol) subs.push(p.symbol); };
      eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);
      await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));
      eventBus.unsubscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);

      const amdCount = subs.filter((s) => s === 'AMD').length;
      expect(amdCount).toBe(1); // never double-requested
      expect(subs).toContain('AMZN');
      expect(subs).toContain('AVGO');
    });
  });

  it('momentum candidates exceeding capacity: top-up correctly contributes zero (momentum alone already saturates the cycle cap)', async () => {
    await withEmptyMomentumStaticLists(async () => {
      process.env[FLAG_O] = 'true';
      vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(['SPY', 'QQQ', 'GLD']);
      vi.spyOn(marketDataWorker, 'getDynamicSymbols').mockReturnValue([]);
      vi.spyOn(marketDataWorker, 'getDynamicMomentumScore').mockReturnValue(0);
      // Small cap: only 3 empty slots.
      vi.spyOn(marketDataWorker, 'getEffectiveStreamingCap').mockReturnValue(6);
      // Momentum offers far more candidates than the 3 available slots.
      const momentumPicks = makeSymbols('MO', 10).map((symbol, i) => ({
        symbol, intradayPctChange: 5, rangeExpansion: 0.01, relativeVolume: 2, momentumScore: 10 - i,
      }));
      vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue(momentumPicks);
      vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockReturnValue(5);
      vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(makeSymbols('BU', 50)));

      const subs: Array<{ symbol?: string; reason?: string }> = [];
      const onSub = (p: { symbol?: string; reason?: string }) => subs.push(p);
      eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);
      await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));
      eventBus.unsubscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);

      expect(subs.length).toBeLessThanOrEqual(continuousIntelligence.maxNewSubscriptionsPerCycle);
      const topUps = subs.filter((s) => s.reason === 'BROAD_UNIVERSE_TOPUP');
      expect(topUps).toHaveLength(0); // no leftover capacity for the broad-universe list to spend
    });
  });

  it('broad-universe admission list is empty: no top-up requested, no crash, momentum picks used as-is', async () => {
    await withEmptyMomentumStaticLists(async () => {
      process.env[FLAG_O] = 'true';
      vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(['SPY', 'QQQ', 'GLD']);
      vi.spyOn(marketDataWorker, 'getDynamicSymbols').mockReturnValue([]);
      vi.spyOn(marketDataWorker, 'getDynamicMomentumScore').mockReturnValue(0);
      vi.spyOn(marketDataWorker, 'getEffectiveStreamingCap').mockReturnValue(20);
      vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([
        { symbol: 'AAPL', intradayPctChange: 2, rangeExpansion: 0.01, relativeVolume: 1.5, momentumScore: 3 },
      ]);
      vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockImplementation((s) => (s === 'AAPL' ? 3 : null));
      vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume([]));

      const subs: string[] = [];
      const onSub = (p: { symbol?: string }) => { if (p.symbol) subs.push(p.symbol); };
      eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);
      const stats = await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));
      eventBus.unsubscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);

      expect(stats.ideasEmitted).toBe(0);
      expect(subs).toEqual(['AAPL']);
    });
  });

  it('an IBKR entitlement failure (code-354-class rejection) on a previously requested symbol does not permanently consume capacity - the symbol remains eligible for a later cycle once it is no longer reported active', async () => {
    await withEmptyMomentumStaticLists(async () => {
      process.env[FLAG_O] = 'true';
      vi.spyOn(marketDataWorker, 'getDynamicSymbols').mockReturnValue([]);
      vi.spyOn(marketDataWorker, 'getDynamicMomentumScore').mockReturnValue(0);
      vi.spyOn(marketDataWorker, 'getEffectiveStreamingCap').mockReturnValue(10);
      vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([]);
      vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(['AAPL', 'AMZN']));

      // Cycle 1: neither symbol active yet - both requested.
      vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValueOnce(['SPY', 'QQQ', 'GLD']);
      const subs1: string[] = [];
      const onSub1 = (p: { symbol?: string }) => { if (p.symbol) subs1.push(p.symbol); };
      eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub1);
      await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));
      eventBus.unsubscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub1);
      expect(subs1).toContain('AAPL');
      expect(subs1).toContain('AMZN');

      // Cycle 2 (real production shape: this is exactly the AAPL/AMD pattern seen live today,
      // 40-46 repeat WATCHLIST_SUBSCRIBE_REQUESTED events over the day): MarketDataWorker's own
      // reqMktData rejection means AAPL never became "active" - the discovery loop correctly does
      // not treat a still-not-active symbol as already handled, and retries it. AMZN, by contrast,
      // succeeded and is now active, so it must NOT be re-requested.
      vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValueOnce(['SPY', 'QQQ', 'GLD', 'AMZN']);
      const subs2: string[] = [];
      const onSub2 = (p: { symbol?: string }) => { if (p.symbol) subs2.push(p.symbol); };
      eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub2);
      await runOpportunityScan(new Date('2026-08-21T14:05:00.000Z'));
      eventBus.unsubscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub2);
      expect(subs2).toContain('AAPL'); // retried - not permanently stuck
      expect(subs2).not.toContain('AMZN'); // already active, not re-requested
    });
  });

  it('determinism: identical inputs across two independent scans produce the identical requested symbol set and order', async () => {
    await withEmptyMomentumStaticLists(async () => {
      process.env[FLAG_O] = 'true';
      const runOnce = async () => {
        resetOpportunityScanForTests();
        // The allocator's aging state is intentionally persistent across cycles within a real
        // session - but that means it must be reset here for a fair "identical inputs" comparison
        // between the two calls below, or run 2 unfairly inherits run 1's accumulated
        // cyclesSkipped history (caught live while building this test).
        resetBroadUniverseAllocatorForTests();
        vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(['SPY', 'QQQ', 'GLD']);
        vi.spyOn(marketDataWorker, 'getDynamicSymbols').mockReturnValue([]);
        vi.spyOn(marketDataWorker, 'getDynamicMomentumScore').mockReturnValue(0);
        vi.spyOn(marketDataWorker, 'getEffectiveStreamingCap').mockReturnValue(30);
        vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([]);
        vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(makeSymbols('DET', 200)));
        const subs: string[] = [];
        const onSub = (p: { symbol?: string }) => { if (p.symbol) subs.push(p.symbol); };
        eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);
        await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));
        eventBus.unsubscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);
        // Deliberately no vi.restoreAllMocks() here - re-spying below overrides these mocks fresh
        // for the second call, and an in-between restore would also clear
        // withEmptyMomentumStaticLists' own movers/news-catalyst mocks, breaking isolation for run 2.
        return subs;
      };
      const first = await runOnce();
      const second = await runOnce();
      expect(second).toEqual(first);
    });
  });

  it('planSnapshotHotSwap (momentum path, unaffected by this fix) remains correct with 0 momentum candidates and 0 empty slots - a no-op, not a crash', () => {
    const planned = planSnapshotHotSwap({
      top: [],
      active: new Set(['SPY', 'QQQ', 'GLD']),
      activeDynamic: [],
      emptySlots: 0,
      maxSwaps: 1,
      scoreEdge: 0.15,
      scoreOf: () => 0,
    });
    expect(planned).toEqual([]);
  });
});
