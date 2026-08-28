/**
 * OpportunityDiscovery — subscribe-only discovery + SnapshotScanner hot-swap.
 * Never emits TRADE_IDEA_GENERATED.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { continuousIntelligence } from '../config/continuousIntelligence';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { marketDataWorker } from '../services/MarketDataWorker';
import {
  runOpportunityScan,
  resetOpportunityScanForTests,
  evaluateOpportunityCandidate,
  getOpportunityScanUniverse,
  planSnapshotHotSwap,
} from './OpportunityDiscovery';
import * as SnapshotScanner from './SnapshotScanner';

const FLAG_O = continuousIntelligence.opportunityLoopEnabledEnvVar;

afterEach(() => {
  delete process.env[FLAG_O];
  resetOpportunityScanForTests();
  SnapshotScanner.resetSnapshotScannerForTests();
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
    vi.spyOn(marketDataWorker, 'getDynamicSymbols').mockReturnValue(
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
});
