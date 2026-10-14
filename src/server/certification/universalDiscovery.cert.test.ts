// LABEL: UNIVERSAL_DISCOVERY baseline (SYNTHETIC_SEEDED / CERTIFICATION_FIXTURE_ONLY) - 2026-10-14
/**
 * Drives Argus's REAL discovery code (SnapshotScanner scoring + ComposableRanking + OpportunityDiscovery hot-swap/top-up planning) minute by
 * minute against a 500-symbol hidden-ground-truth market. Argus sees only published market data; the independent OpportunityOracle holds the
 * truth. This test MEASURES (recall, precision, Recall@K, MRR, latency, miss classes, out-of-watchlist recall) and writes a report; it does not
 * assert invented thresholds - the baseline decides them. It DOES assert harness integrity (determinism, no leakage of ground truth into
 * production code, every opportunity explained).
 *
 * Scope note (honest): this phase certifies universe -> scan -> rank -> promotion request. The promoted-symbol -> Quant -> idea -> Chief ->
 * Risk -> OMS leg is certified by the full synthetic session suite; wiring the two into a single 500-symbol funnel run is the next phase.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const feed = vi.hoisted(() => ({ market: null as any, minute: 0 }));
vi.mock('../core/alpacaTls', () => ({
  alpacaFetch: async (url: string) => {
    const symbols = decodeURIComponent((/symbols=([^&]*)/.exec(url)?.[1]) ?? '').split(',').filter(Boolean);
    const body: Record<string, unknown> = {};
    for (const s of symbols) { const snap = feed.market?.snapshot(s, feed.minute); if (snap) body[s] = snap; }
    return { ok: true, status: 200, json: async () => body };
  },
}));

import { SyntheticDiscoveryMarket, SESSION_MINUTES, type DiscoveryMarketConfig } from '../replay/synthetic/discovery/SyntheticDiscoveryMarket';
import { buildTruth, scoreDiscovery, type ArgusDiscoveryLog } from '../replay/synthetic/discovery/OpportunityOracle';

const OPEN_MS = new Date('2026-09-15T13:30:00.000Z').getTime();

describe('UNIVERSAL_DISCOVERY baseline against a hidden-ground-truth 500-symbol market', () => {
  let tmp: string; let sqliteDb: any;
  let continuousIntelligence: any; let eventBus: any; let EVENTS: any; let marketDataWorker: any;
  let Opp: typeof import('../continuous/OpportunityDiscovery');
  let Snap: typeof import('../continuous/SnapshotScanner');
  let MUS: typeof import('../continuous/MarketUniverseScanner');
  let Alloc: typeof import('../continuous/BroadUniverseSubscriptionAllocator');
  const reports: any[] = [];

  beforeAll(async () => {
    tmp = path.join(os.tmpdir(), `argus_universal_discovery_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmp;
    ({ sqliteDb } = await import('../db'));
    ({ continuousIntelligence } = await import('../config/continuousIntelligence'));
    ({ eventBus } = await import('../core/EventBus'));
    ({ EVENTS } = await import('../core/eventNames'));
    ({ marketDataWorker } = await import('../services/MarketDataWorker'));
    Opp = await import('../continuous/OpportunityDiscovery');
    Snap = await import('../continuous/SnapshotScanner');
    MUS = await import('../continuous/MarketUniverseScanner');
    Alloc = await import('../continuous/BroadUniverseSubscriptionAllocator');
  });
  afterAll(() => {
    try { sqliteDb.close(); } catch { /* closed */ }
    for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(tmp + s); } catch { /* best effort */ } }
    delete process.env.ARGUS_DB_PATH;
    const dir = process.env.DISCOVERY_REPORT_DIR || os.tmpdir();
    try { fs.writeFileSync(path.join(dir, 'universal-discovery-baseline.json'), JSON.stringify({ label: 'SYNTHETIC_SEEDED / CERTIFICATION_FIXTURE_ONLY - baseline measurement, no thresholds asserted', reports }, null, 2)); } catch { /* best effort */ }
  });
  afterEach(() => { vi.restoreAllMocks(); Opp.resetOpportunityScanForTests(); Snap.resetSnapshotScannerForTests(); Alloc.resetBroadUniverseAllocatorForTests(); });

  async function runDay(cfg: DiscoveryMarketConfig, label: string) {
    const market = new SyntheticDiscoveryMarket(cfg);
    feed.market = market;
    const truth = buildTruth(market);
    const flag = continuousIntelligence.opportunityLoopEnabledEnvVar;
    process.env[flag] = 'true';
    const saved = {
      seed: continuousIntelligence.seedSymbols, watch: continuousIntelligence.watchUniverseSymbols, surge: continuousIntelligence.campaignOpeningSurgeSymbols,
      mom: continuousIntelligence.momentumScanUniverseSymbols, core: continuousIntelligence.coreStreamingSymbols,
    };
    // Argus's configured starting list = the market's starting watchlist (it does NOT contain the future winners by construction when outsideFraction=1)
    continuousIntelligence.seedSymbols = []; continuousIntelligence.watchUniverseSymbols = []; continuousIntelligence.campaignOpeningSurgeSymbols = [];
    continuousIntelligence.momentumScanUniverseSymbols = [...market.startingWatchlist]; continuousIntelligence.coreStreamingSymbols = [];

    // data feeds Argus would receive in production (derived from PUBLISHED prices only)
    // production cadences: broad scan every 15 min (its gap evidence ages between refreshes), movers every 5 min
    const BROAD_REFRESH_MIN = Number(process.env.DISCOVERY_BROAD_REFRESH_MIN ?? 15); const MOVERS_REFRESH_MIN = Number(process.env.DISCOVERY_MOVERS_REFRESH_MIN ?? 5);
    vi.spyOn(MUS, 'getCachedBroadUniverseCandidatesWithVolume').mockImplementation(() => market.broadUniverse(Math.floor(feed.minute / BROAD_REFRESH_MIN) * BROAD_REFRESH_MIN));
    vi.spyOn(MUS, 'getCachedBroadUniverseGapPct').mockImplementation((sym: string) => market.sessionMoveAt(sym, Math.floor(feed.minute / BROAD_REFRESH_MIN) * BROAD_REFRESH_MIN));
    vi.spyOn(MUS, 'getCachedMoverSymbols').mockImplementation(() => market.moversAt(Math.floor(feed.minute / MOVERS_REFRESH_MIN) * MOVERS_REFRESH_MIN, 20));
    vi.spyOn(MUS, 'getCachedNewsCatalystSymbols').mockReturnValue([]);

    // market data capacity model: 12 slots total, dynamic slots filled by Argus's own subscribe requests (FIFO eviction when full)
    const CAP = 12; const dynamic: string[] = [];
    vi.spyOn(marketDataWorker, 'getActiveSymbols').mockImplementation(() => [...dynamic]);
    vi.spyOn(marketDataWorker, 'getDynamicSymbols').mockImplementation(() => [...dynamic]);
    vi.spyOn(marketDataWorker, 'getEvictionEligibleDynamicSymbols').mockImplementation(() => [...dynamic]);
    vi.spyOn(marketDataWorker, 'getDynamicMomentumScore').mockReturnValue(0);
    vi.spyOn(marketDataWorker, 'getEffectiveStreamingCap').mockReturnValue(CAP);
    vi.spyOn(marketDataWorker, 'refreshDynamicScores').mockImplementation(() => undefined as any);

    const log: ArgusDiscoveryLog = { scanned: new Map(), ranked: new Map(), topK: { 5: new Map(), 10: new Map(), 20: new Map() }, promoted: new Map(), moversOffered: new Map() };
    let minuteNow = 0;
    // Diagnostics (read-only, never feeds Argus): the REAL challenger score of each opportunity a few minutes after it became observable, vs the weakest incumbent's real score.
    const diag: Array<{ symbol: string; inside: boolean; atMin: number; challengerScore: number; weakestIncumbent: number | null; gapPct: number | null; baseScore: number | null; activeDynamic: number }> = [];
    const probeAt = new Map<number, string[]>();
    for (const o of truth.opportunities) if (o.firstObservableMin !== null) { const t = o.firstObservableMin + 3; probeAt.set(t, [...(probeAt.get(t) ?? []), o.symbol]); }
    const onSub = (p: { symbol?: string }) => {
      if (!p.symbol) return;
      if (!log.promoted.has(p.symbol)) log.promoted.set(p.symbol, minuteNow);
      if (!dynamic.includes(p.symbol)) { dynamic.push(p.symbol); if (dynamic.length > CAP) dynamic.shift(); }
    };
    eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);
    const t0 = Date.now();
    try {
      for (let m = 0; m < SESSION_MINUTES; m++) {
        minuteNow = m; feed.minute = m;
        const now = new Date(OPEN_MS + m * 60_000);
        for (const sym of market.moversAt(Math.floor(m / Number(process.env.DISCOVERY_MOVERS_REFRESH_MIN ?? 5)) * Number(process.env.DISCOVERY_MOVERS_REFRESH_MIN ?? 5), 20)) if (!log.moversOffered!.has(sym)) log.moversOffered!.set(sym, m);
        await Opp.runOpportunityScan(now);
        for (const sym of Opp.getOpportunityScanUniverse()) if (!log.scanned.has(sym)) log.scanned.set(sym, m);
        for (const sym of probeAt.get(m) ?? []) {
          const base = (s: string) => Snap.getLastSnapshotScore(s) ?? 0;
          const gap = MUS.getCachedBroadUniverseGapPct(sym);
          const inc = dynamic.map((d) => Opp.scoreBroadUniverseChallenger(d, MUS.getCachedBroadUniverseGapPct(d), base));
          diag.push({ symbol: sym, inside: market.startingWatchlist.includes(sym), atMin: m, challengerScore: Opp.scoreBroadUniverseChallenger(sym, gap, base), weakestIncumbent: inc.length ? Math.min(...inc) : null, gapPct: gap, baseScore: Snap.getLastSnapshotScore(sym), activeDynamic: dynamic.length });
        }
        const ranked = await Snap.getTopMomentumCandidates(200, { cachedOnly: true, now });
        ranked.forEach((r, i) => {
          const rank = i + 1;
          const cur = log.ranked.get(r.symbol);
          if (!cur) log.ranked.set(r.symbol, { firstMin: m, bestRank: rank }); else cur.bestRank = Math.min(cur.bestRank, rank);
          for (const k of [5, 10, 20]) if (rank <= k && !log.topK[k].has(r.symbol)) log.topK[k].set(r.symbol, m);
        });
      }
    } finally {
      eventBus.unsubscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);
      continuousIntelligence.seedSymbols = saved.seed; continuousIntelligence.watchUniverseSymbols = saved.watch; continuousIntelligence.campaignOpeningSurgeSymbols = saved.surge;
      continuousIntelligence.momentumScanUniverseSymbols = saved.mom; continuousIntelligence.coreStreamingSymbols = saved.core;
      delete process.env[flag];
    }
    const score = scoreDiscovery(truth, log, new Set(market.startingWatchlist));
    const report = { label: label + `|broad${process.env.DISCOVERY_BROAD_REFRESH_MIN ?? 15}-movers${process.env.DISCOVERY_MOVERS_REFRESH_MIN ?? 5}`, cfg, wallS: +((Date.now() - t0) / 1000).toFixed(1), valid: truth.opportunities.length, traps: truth.traps.length, score, diag };
    reports.push(report);
    console.log(`[DISCOVERY ${label}] eligible=${score.eligible} found=${score.discoveredInTime} recall=${score.recall} outsideRecall=${score.recallOutsideWatchlist} insideRecall=${score.recallInsideWatchlist} precision=${score.precision} promoted=${score.promotedTotal} trapHits=${score.promotedTrapHits} R@5=${score.recallAtK[5]} R@10=${score.recallAtK[10]} R@20=${score.recallAtK[20]} MRR=${score.meanReciprocalRank} latP50=${score.latencyMin.p50} latP95=${score.latencyMin.p95} classes=${JSON.stringify(score.missByClass)}`);
    return { market, truth, score, log };
  }

  it('harness integrity: deterministic from the seed, and production code never imports the ground-truth market', () => {
    const cfg: DiscoveryMarketConfig = { seed: 101, universeSize: 500, startingWatchlistSize: 120, validCount: 20, trapCount: 8, outsideFraction: 0.6 };
    const a = new SyntheticDiscoveryMarket(cfg); const b = new SyntheticDiscoveryMarket(cfg);
    expect(a.groundTruth()).toEqual(b.groundTruth());
    expect(a.snapshot(a.symbols[7], 200)).toEqual(b.snapshot(b.symbols[7], 200));
    const other = new SyntheticDiscoveryMarket({ ...cfg, seed: 102 });
    expect(other.groundTruth().map((s) => s.symbol)).not.toEqual(a.groundTruth().map((s) => s.symbol)); // opportunities move with the seed
    const root = path.resolve(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!/replay[\\/]synthetic|certification/.test(p)) walk(p); continue; }
        if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && /SyntheticDiscoveryMarket|OpportunityOracle/.test(fs.readFileSync(p, 'utf8'))) offenders.push(p);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it('seed 101: mixed day (60% of valid opportunities outside the starting watchlist)', async () => {
    const { score } = await runDay({ seed: 101, universeSize: 500, startingWatchlistSize: 120, validCount: 20, trapCount: 8, outsideFraction: 0.6 }, 'seed101-mixed');
    expect(score.opportunities.every((o) => !!o.classification)).toBe(true); // every opportunity is explained
  }, 900_000);

  it('seed 102: watchlist is boring - every valid opportunity is OUTSIDE the starting watchlist', async () => {
    const { score } = await runDay({ seed: 102, universeSize: 500, startingWatchlistSize: 120, validCount: 20, trapCount: 8, outsideFraction: 1 }, 'seed102-outside-only');
    expect(score.opportunities.every((o) => !o.insideStartingWatchlist)).toBe(true);
  }, 900_000);

  it('seed 103: watchlist-only day (all valid opportunities inside the watchlist) - the control', async () => {
    const { score } = await runDay({ seed: 103, universeSize: 500, startingWatchlistSize: 120, validCount: 20, trapCount: 8, outsideFraction: 0 }, 'seed103-inside-only');
    expect(score.opportunities.every((o) => o.insideStartingWatchlist)).toBe(true);
  }, 900_000);
});
