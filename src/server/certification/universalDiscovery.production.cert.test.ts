// LABEL: UNIVERSAL_DISCOVERY production-stack certification (SYNTHETIC_SEEDED / CERTIFICATION_FIXTURE_ONLY) - 2026-10-14 Oct 14 forensic response.
/**
 * Runs the REAL discovery stack minute by minute against a 500-symbol hidden-truth market with an initially OCCUPIED IBKR-style 90-line allocation:
 *   real MarketUniverseScanner (assets/snapshots/ADV/movers screens through the guarded provider seam), real SnapshotScanner, real ComposableRanking inputs,
 *   real OpportunityDiscovery hot-swap planning and WATCHLIST_SUBSCRIBE_REQUESTED -> real MarketDataWorker allocator (dwell, rescue immunity, eviction, cap 90).
 * Only the external market-data boundary is replaced (SyntheticAlpacaProvider). Compared with the earlier 12-slot/mocked harness there are NO spies on scanner
 * getters or on MarketDataWorker eviction.
 *
 * Arms (env DISCOVERY_ARM): LEGACY = the Oct 14 production behaviors (routine rescue renewals grant immunity, dwell released at 10 ticks);
 *                           REPAIRED = the candidate defaults. Same seed, same market, same pressure: only the two flags differ.
 * Rescue pressure reproduces the observed Oct 14 pattern (~14.5k routine renewals/day ~ 37/min over the curated incumbents).
 * Measures recall/precision against the independent OpportunityOracle and the lifetime of every promoted opportunity (quick evictions before ~60 s).
 * Writes a JSON report to DISCOVERY_REPORT_DIR; asserts only harness integrity (no blocked provider traffic, deterministic wiring), never an invented threshold.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const OPEN_MS = Date.parse('2026-10-14T13:30:00.000Z');
const ARM = (process.env.DISCOVERY_ARM ?? 'REPAIRED').toUpperCase();
const SEED = Number(process.env.DISCOVERY_SEED ?? 102);
const OUTSIDE = Number(process.env.DISCOVERY_OUTSIDE_FRACTION ?? 1);
const UNIVERSE = Number(process.env.DISCOVERY_UNIVERSE ?? 500);
const MINUTES = Number(process.env.DISCOVERY_MINUTES ?? 390);
const RENEWALS_PER_MIN = Number(process.env.DISCOVERY_RENEWALS_PER_MIN ?? 37);
const INCUMBENTS = Number(process.env.DISCOVERY_INCUMBENTS ?? 87);

describe(`UNIVERSAL_DISCOVERY production-stack (arm=${ARM}, seed=${SEED})`, () => {
  let tmp: string; let sqliteDb: any;
  it('runs the session and reports', async () => {
    tmp = path.join(os.tmpdir(), `argus_certification_discovery_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmp;
    process.env.SYNTHETIC_SIMULATION = 'true';
    ({ sqliteDb } = await import('../db'));
    const { continuousIntelligence } = await import('../config/continuousIntelligence');
    const { marketDataWorker } = await import('../services/MarketDataWorker');
    const { structuredLogger } = await import('../observability/StructuredLogger');
    const { installSyntheticAlpacaProvider, getBlockedSyntheticAlpacaCalls, resetBlockedSyntheticAlpacaCalls } = await import('../core/alpacaTls');
    const Opp = await import('../continuous/OpportunityDiscovery');
    const Snap = await import('../continuous/SnapshotScanner');
    const MUS = await import('../continuous/MarketUniverseScanner');
    const Alloc = await import('../continuous/BroadUniverseSubscriptionAllocator');
    const { SyntheticDiscoveryMarket, SESSION_MINUTES } = await import('../replay/synthetic/discovery/SyntheticDiscoveryMarket');
    const { createSyntheticAlpacaProvider } = await import('../replay/synthetic/discovery/SyntheticAlpacaProvider');
    const { buildTruth, scoreDiscovery } = await import('../replay/synthetic/discovery/OpportunityOracle');

    // ---- arm configuration (the ONLY difference between arms) ----
    const saved = { rescue: continuousIntelligence.temporaryDataRescueRoutineRenewalGrantsImmunity, dwell: continuousIntelligence.minDynamicDwellReleasesOnTicks };
    continuousIntelligence.temporaryDataRescueRoutineRenewalGrantsImmunity = ARM === 'LEGACY';
    continuousIntelligence.minDynamicDwellReleasesOnTicks = ARM === 'LEGACY';

    const market = new SyntheticDiscoveryMarket({ seed: SEED, universeSize: UNIVERSE, startingWatchlistSize: 120, validCount: 20, trapCount: 8, outsideFraction: OUTSIDE });
    const truth = buildTruth(market);
    let nowMs = OPEN_MS; let minute = 0;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    installSyntheticAlpacaProvider(createSyntheticAlpacaProvider(market, { minute: () => minute, nowMs: () => nowMs }).fetch);
    resetBlockedSyntheticAlpacaCalls();
    const flags = [continuousIntelligence.opportunityLoopEnabledEnvVar, continuousIntelligence.broadUniverseEnabledEnvVar, continuousIntelligence.moversEnabledEnvVar];
    for (const f of flags) process.env[f] = 'true';
    const savedLists = { seed: continuousIntelligence.seedSymbols, watch: continuousIntelligence.watchUniverseSymbols, surge: continuousIntelligence.campaignOpeningSurgeSymbols, mom: continuousIntelligence.momentumScanUniverseSymbols, core: continuousIntelligence.coreStreamingSymbols };
    continuousIntelligence.seedSymbols = []; continuousIntelligence.watchUniverseSymbols = []; continuousIntelligence.campaignOpeningSurgeSymbols = [];
    continuousIntelligence.momentumScanUniverseSymbols = [...market.startingWatchlist]; continuousIntelligence.coreStreamingSymbols = ['SPY', 'QQQ', 'GLD'];

    // ---- production-style IBKR allocation: cap 90, real allocator, real watchlist listener ----
    const bridge = { subscribe() {}, unsubscribe() {}, clear() {}, isConnected: () => true };
    marketDataWorker.setBrokerQuoteContext({ backend: 'ibkr_gateway', hardCapOverride: 90, ibkrBridge: bridge as any });
    (marketDataWorker as any).ensureWatchlistListener();
    for (const core of ['SPY', 'QQQ', 'GLD']) marketDataWorker.subscribe(core);
    const incumbents = market.startingWatchlist.slice(0, INCUMBENTS);
    for (const sym of incumbents) { marketDataWorker.subscribe(sym, { momentumScore: 1 }); (marketDataWorker as any).subscribedAtMs.set(sym, nowMs - 2 * 3600_000); (marketDataWorker as any).tickCounts.set(sym, 500); }
    expect(marketDataWorker.getActiveSymbols().length).toBe(90); // initially FULL, not 90 free slots

    // spy on the production decision logs (reason codes) without changing behavior
    const reasonCounts: Record<string, number> = {};
    const infoSpy = vi.spyOn(structuredLogger, 'info');
    const liquidRank = new Map(market.symbols.map((s) => [s, (market.prevCloseOf(s) ?? 1) * (market.snapshot(s, 0)?.prevDailyBar.v ?? 1)]));
    const sortedLiquid = [...liquidRank.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
    const liquidSet = new Set(sortedLiquid.slice(0, Math.floor(sortedLiquid.length * 0.4)));

    const log = { scanned: new Map<string, number>(), ranked: new Map<string, { firstMin: number; bestRank: number }>(), topK: { 5: new Map<string, number>(), 10: new Map<string, number>(), 20: new Map<string, number>() }, promoted: new Map<string, number>(), moversOffered: new Map<string, number>() };
    const everActive = new Set(marketDataWorker.getActiveSymbols());
    const joinedAt = new Map<string, number>(); const leftAt = new Map<string, number>();
    const lifetimes: Array<{ symbol: string; joined: number; left: number | null }> = [];
    const samples: Array<{ minute: number; active: number; rescueHolders: number; evictable: number }> = [];
    let rr = 0;

    try {
      for (let m = 0; m < Math.min(MINUTES, SESSION_MINUTES); m++) {
        minute = m; const base = OPEN_MS + m * 60_000;
        // ticks for every streaming symbol (liquid names tick fast - the dwell-bug precondition)
        const active = marketDataWorker.getActiveSymbols();
        for (const sym of active) {
          const n = liquidSet.has(sym) || ['SPY', 'QQQ', 'GLD'].includes(sym) ? 20 : 6;
          const px = market.snapshot(sym, m)?.latestTrade.p ?? 100;
          for (let k = 0; k < n; k++) { nowMs = base + Math.floor((k * 54_000) / n); marketDataWorker.ingestIbkrQuote(sym, px); }
        }
        nowMs = base + 55_000;
        // routine Fundamental/Macro-style rescue renewals on already-streaming curated names (Oct 14: ~37/min)
        for (let i = 0; i < RENEWALS_PER_MIN; i++) { const sym = incumbents[rr++ % incumbents.length]; marketDataWorker.requestTemporaryDataRescue(sym, 'fundamental read'); }
        if (m % 5 === 0) await MUS.refreshMoversCache();
        if (m % 15 === 0) await MUS.refreshBroadUniverseCache();
        for (const sym of MUS.getCachedMoverSymbols()) if (!log.moversOffered.has(sym)) log.moversOffered.set(sym, m);
        await Opp.runOpportunityScan(new Date(nowMs));
        for (const sym of Opp.getOpportunityScanUniverse()) if (!log.scanned.has(sym)) log.scanned.set(sym, m);
        const ranked = await Snap.getTopMomentumCandidates(200, { cachedOnly: true, now: new Date(nowMs) });
        ranked.forEach((r, i) => {
          const rank = i + 1; const cur = log.ranked.get(r.symbol);
          if (!cur) log.ranked.set(r.symbol, { firstMin: m, bestRank: rank }); else cur.bestRank = Math.min(cur.bestRank, rank);
          for (const k of [5, 10, 20] as const) if (rank <= k && !(log.topK[k] as Map<string, number>).has(r.symbol)) (log.topK[k] as Map<string, number>).set(r.symbol, m);
        });
        // lifecycle of real subscriptions
        const nowActive = new Set(marketDataWorker.getActiveSymbols());
        for (const sym of nowActive) if (!everActive.has(sym) || !joinedAt.has(sym)) { if (!everActive.has(sym)) { everActive.add(sym); log.promoted.set(sym, m); } if (!joinedAt.has(sym)) joinedAt.set(sym, nowMs); }
        for (const [sym, t] of [...joinedAt]) if (!nowActive.has(sym)) { lifetimes.push({ symbol: sym, joined: t, left: nowMs }); joinedAt.delete(sym); }
        if (m % 15 === 0) samples.push({ minute: m, active: nowActive.size, rescueHolders: marketDataWorker.getActiveTemporaryRescues().length, evictable: marketDataWorker.getEvictionEligibleDynamicSymbols().length });
      }
      for (const [sym, t] of joinedAt) lifetimes.push({ symbol: sym, joined: t, left: null });
      for (const c of infoSpy.mock.calls) { const p = c[1] as any; if (c[0] === 'subscription_priority_decision' && p?.eventType === 'SUBSCRIPTION_NOT_PROMOTED') reasonCounts[p.reasonCode ?? '?'] = (reasonCounts[p.reasonCode ?? '?'] ?? 0) + 1; }
    } finally {
      dateSpy.mockRestore(); infoSpy.mockRestore(); installSyntheticAlpacaProvider(null);
      for (const f of flags) delete process.env[f];
      Object.assign(continuousIntelligence, { seedSymbols: savedLists.seed, watchUniverseSymbols: savedLists.watch, campaignOpeningSurgeSymbols: savedLists.surge, momentumScanUniverseSymbols: savedLists.mom, coreStreamingSymbols: savedLists.core });
      continuousIntelligence.temporaryDataRescueRoutineRenewalGrantsImmunity = saved.rescue; continuousIntelligence.minDynamicDwellReleasesOnTicks = saved.dwell;
      Opp.resetOpportunityScanForTests(); Snap.resetSnapshotScannerForTests(); Alloc.resetBroadUniverseAllocatorForTests(); MUS.resetMarketUniverseScannerForTests();
    }

    const score = scoreDiscovery(truth, log as any, new Set(market.startingWatchlist));
    const oppSyms = new Set(truth.opportunities.map((o) => o.symbol));
    const promotedOpp = lifetimes.filter((l) => oppSyms.has(l.symbol) && !incumbents.includes(l.symbol));
    const quick = lifetimes.filter((l) => l.left !== null && (l.left as number) - l.joined < 60_000 && !incumbents.includes(l.symbol));
    const report = {
      arm: ARM, seed: SEED, universe: UNIVERSE, incumbents: INCUMBENTS, renewalsPerMin: RENEWALS_PER_MIN, outsideFraction: OUTSIDE,
      score: { eligible: score.eligible, discoveredInTime: score.discoveredInTime, recall: score.recall, recallOutside: score.recallOutsideWatchlist, precision: score.precision, promotedTotal: score.promotedTotal, trapHits: score.promotedTrapHits, latencyMin: score.latencyMin, missByClass: score.missByClass },
      promotions: { distinctNewSubscriptions: log.promoted.size, quickEvictionsUnder60s: quick.length, opportunityLifetimeUnder60s: promotedOpp.filter((l) => l.left !== null && (l.left as number) - l.joined < 60_000).length },
      notPromotedReasons: reasonCounts, occupancySamples: samples,
      providerUnsupported: [], blockedCalls: getBlockedSyntheticAlpacaCalls().length,
      opportunities: score.opportunities.map((o) => ({ symbol: o.symbol, kind: o.kind, firstObservable: o.firstObservableMin, expiry: o.expiryMin, promotedMin: o.promotedMin, cls: o.classification })),
    };
    const dir = process.env.DISCOVERY_REPORT_DIR || os.tmpdir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `discovery-production-${ARM}-seed${SEED}.json`), JSON.stringify(report, null, 1));
    // eslint-disable-next-line no-console
    console.log(`[DISCOVERY-PRODUCTION ${ARM} seed=${SEED}] eligible=${score.eligible} found=${score.discoveredInTime} recall=${score.recall} outsideRecall=${score.recallOutsideWatchlist} precision=${score.precision} promotedNew=${log.promoted.size} quickEvict=${quick.length} reasons=${JSON.stringify(reasonCounts)} occupancy=${JSON.stringify(samples.filter((s) => s.minute % 90 === 0))}`);
    expect(getBlockedSyntheticAlpacaCalls()).toEqual([]);
    expect(score.opportunities.every((o) => !!o.classification)).toBe(true);
  }, 3_600_000);

  afterAll(() => {
    try { sqliteDb?.close(); } catch { /* closed */ }
    if (tmp) for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(tmp + s); } catch { /* best effort */ } }
    delete process.env.ARGUS_DB_PATH;
  });
});
