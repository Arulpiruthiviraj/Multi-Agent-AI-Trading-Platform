/**
 * SessionDiscoveryDriver (2026-10-14) - runs the REAL production discovery -> ranking -> subscription -> eviction/rescue stack INSIDE a full synthetic
 * session (SyntheticSessionEngine), against a hidden-truth market served through the guarded external-provider seam. Evidence class SYNTHETIC_SEEDED /
 * CERTIFICATION_FIXTURE_ONLY.
 *
 * What is real: MarketUniverseScanner (assets/snapshots/ADV/movers screens), SnapshotScanner, OpportunityDiscovery hot-swap planning, the
 * WATCHLIST_SUBSCRIBE_REQUESTED listener, MarketDataWorker's allocator (cap 90, dwell, rescue immunity, eviction, held-position protection), and
 * requestTemporaryDataRescue. What is simulated: ONLY the external boundary - the Alpaca REST provider (SyntheticAlpacaProvider) and the IBKR line bridge
 * (a no-op stub: there is no Gateway to subscribe lines with). The engine itself then feeds bars/ticks ONLY for symbols the real allocator has subscribed.
 *
 * Disclosed preconditions (not behavior changes): incumbents are subscribed with backdated subscription state (they were streaming earlier, as in
 * production); optional routine rescue-renewal pressure (Oct 14 observed ~37/min over curated names) is applied through the real
 * requestTemporaryDataRescue entry point.
 */
import type { SyntheticDiscoveryMarket } from './SyntheticDiscoveryMarket';

export interface SessionDiscoveryOptions {
  seed: number;
  universeSize: number;
  startingWatchlistSize: number;
  validCount: number;
  trapCount: number;
  /** fraction of valid opportunities outside the starting watchlist (1 = the configured list is boring) */
  outsideFraction: number;
  /** lines occupied by incumbents at open (total cap is 90; 3 core streaming + incumbents) */
  incumbentCount: number;
  /** routine ROUTINE_RECOVERY rescue renewals per simulated minute over the incumbents (Oct 14 observed ~37) */
  renewalsPerMinute: number;
  hardCap: number;
}
export const DEFAULT_SESSION_DISCOVERY: SessionDiscoveryOptions = {
  seed: 102, universeSize: 500, startingWatchlistSize: 120, validCount: 20, trapCount: 8, outsideFraction: 1, incumbentCount: 87, renewalsPerMinute: 37, hardCap: 90,
};

export class SessionDiscoveryDriver {
  market!: SyntheticDiscoveryMarket;
  incumbents: string[] = [];
  readonly coreSymbols: string[] = [];
  readonly log = { scanned: new Map<string, number>(), ranked: new Map<string, { firstMin: number; bestRank: number }>(), topK: { 5: new Map<string, number>(), 10: new Map<string, number>(), 20: new Map<string, number>() }, promoted: new Map<string, number>(), moversOffered: new Map<string, number>() };
  readonly reasonCounts: Record<string, number> = {};
  readonly samples: Array<{ minute: number; active: number; rescueHolders: number; evictable: number }> = [];
  readonly lifetimes: Array<{ symbol: string; joined: number; left: number | null }> = [];
  private joinedAt = new Map<string, number>();
  private everActive = new Set<string>();
  private rr = 0;
  private minute = 0;
  private restore: Array<() => void> = [];
  private mods!: { MUS: any; Opp: any; Snap: any; Alloc: any; mdw: any; ci: any; alpacaTls: any; logger: any };
  private infoOrig: any;

  constructor(readonly opts: SessionDiscoveryOptions = DEFAULT_SESSION_DISCOVERY) {}

  /** Build the market (pure) - call before the engine generates bars. */
  async buildMarket(): Promise<SyntheticDiscoveryMarket> {
    const { SyntheticDiscoveryMarket: Market } = await import('./SyntheticDiscoveryMarket');
    this.market = new Market({ seed: this.opts.seed, universeSize: this.opts.universeSize, startingWatchlistSize: this.opts.startingWatchlistSize, validCount: this.opts.validCount, trapCount: this.opts.trapCount, outsideFraction: this.opts.outsideFraction });
    this.coreSymbols.push(...this.market.startingWatchlist.slice(0, 3));
    this.incumbents = this.market.startingWatchlist.slice(3, 3 + this.opts.incumbentCount);
    return this.market;
  }

  /** Symbols streaming at open (core + incumbents) - the engine's initial live universe. */
  initialSymbols(): string[] { return [...this.coreSymbols, ...this.incumbents]; }

  /** Install the provider seam, flags, lists and the IBKR-style allocation. nowMs must be the SIMULATED clock (Date.now is patched to it by the engine). */
  async install(args: { nowMs: () => number; sessionDay: string }): Promise<void> {
    const m = this.mods = {
      MUS: await import('../../../continuous/MarketUniverseScanner'), Opp: await import('../../../continuous/OpportunityDiscovery'), Snap: await import('../../../continuous/SnapshotScanner'),
      Alloc: await import('../../../continuous/BroadUniverseSubscriptionAllocator'), mdw: (await import('../../../services/MarketDataWorker')).marketDataWorker,
      ci: (await import('../../../config/continuousIntelligence')).continuousIntelligence, alpacaTls: await import('../../../core/alpacaTls'), logger: (await import('../../../observability/StructuredLogger')).structuredLogger,
    };
    const { createSyntheticAlpacaProvider } = await import('./SyntheticAlpacaProvider');
    const provider = createSyntheticAlpacaProvider(this.market, { minute: () => this.minute, nowMs: args.nowMs }, { sessionDay: args.sessionDay });
    m.alpacaTls.installSyntheticAlpacaProvider(provider.fetch);
    m.alpacaTls.resetBlockedSyntheticAlpacaCalls();
    this.restore.push(() => m.alpacaTls.installSyntheticAlpacaProvider(null));

    const flags = [m.ci.opportunityLoopEnabledEnvVar, m.ci.broadUniverseEnabledEnvVar, m.ci.moversEnabledEnvVar];
    for (const f of flags) process.env[f] = 'true';
    this.restore.push(() => { for (const f of flags) process.env[f] = 'false'; });

    const saved = { seed: m.ci.seedSymbols, watch: m.ci.watchUniverseSymbols, surge: m.ci.campaignOpeningSurgeSymbols, mom: m.ci.momentumScanUniverseSymbols, core: m.ci.coreStreamingSymbols };
    m.ci.seedSymbols = []; m.ci.watchUniverseSymbols = []; m.ci.campaignOpeningSurgeSymbols = [];
    m.ci.momentumScanUniverseSymbols = [...this.market.startingWatchlist]; m.ci.coreStreamingSymbols = [...this.coreSymbols];
    this.restore.push(() => Object.assign(m.ci, { seedSymbols: saved.seed, watchUniverseSymbols: saved.watch, campaignOpeningSurgeSymbols: saved.surge, momentumScanUniverseSymbols: saved.mom, coreStreamingSymbols: saved.core }));

    const bridge = { subscribe() {}, unsubscribe() {}, clear() {}, isConnected: () => true };
    m.mdw.setBrokerQuoteContext({ backend: 'ibkr_gateway', hardCapOverride: this.opts.hardCap, ibkrBridge: bridge as any });
    (m.mdw as any).ensureWatchlistListener();
    const nowMs = args.nowMs();
    for (const core of this.coreSymbols) m.mdw.subscribe(core);
    for (const sym of this.incumbents) {
      m.mdw.subscribe(sym, { momentumScore: 1 });
      (m.mdw as any).subscribedAtMs.set(sym, nowMs - 2 * 3600_000); // disclosed precondition: incumbents were already streaming
      (m.mdw as any).tickCounts.set(sym, 500);
    }
    if (m.mdw.getActiveSymbols().length !== this.opts.hardCap) throw new Error(`discovery precondition failed: expected ${this.opts.hardCap} occupied lines, got ${m.mdw.getActiveSymbols().length}`);
    for (const s of m.mdw.getActiveSymbols()) this.everActive.add(s);

    // capture the production decision log (reason codes) without changing behavior
    this.infoOrig = m.logger.info.bind(m.logger);
    const self = this;
    m.logger.info = (...a: any[]) => {
      try { const p = a[1] as any; if (a[0] === 'subscription_priority_decision' && p?.eventType === 'SUBSCRIPTION_NOT_PROMOTED') self.reasonCounts[p.reasonCode ?? '?'] = (self.reasonCounts[p.reasonCode ?? '?'] ?? 0) + 1; } catch { /* observation only */ }
      return self.infoOrig(...a);
    };
    this.restore.push(() => { m.logger.info = this.infoOrig; });
    this.providerRef = provider;
  }
  private providerRef: { unsupported: string[] } | null = null;

  /** One simulated minute of discovery. Runs after the engine has delivered this minute's ticks; Date.now already equals the simulated time. */
  async step(minute: number, nowMs: number): Promise<void> {
    const { MUS, Opp, Snap, mdw } = this.mods;
    this.minute = minute;
    for (let i = 0; i < this.opts.renewalsPerMinute; i++) { const sym = this.incumbents[this.rr++ % this.incumbents.length]; mdw.requestTemporaryDataRescue(sym, 'fundamental read'); }
    if (minute % 5 === 0) await MUS.refreshMoversCache();
    if (minute % 15 === 0) await MUS.refreshBroadUniverseCache();
    for (const sym of MUS.getCachedMoverSymbols()) if (!this.log.moversOffered.has(sym)) this.log.moversOffered.set(sym, minute);
    await Opp.runOpportunityScan(new Date(nowMs));
    for (const sym of Opp.getOpportunityScanUniverse()) if (!this.log.scanned.has(sym)) this.log.scanned.set(sym, minute);
    const ranked = await Snap.getTopMomentumCandidates(200, { cachedOnly: true, now: new Date(nowMs) });
    ranked.forEach((r: any, i: number) => {
      const rank = i + 1; const cur = this.log.ranked.get(r.symbol);
      if (!cur) this.log.ranked.set(r.symbol, { firstMin: minute, bestRank: rank }); else cur.bestRank = Math.min(cur.bestRank, rank);
      for (const k of [5, 10, 20] as const) if (rank <= k && !(this.log.topK[k] as Map<string, number>).has(r.symbol)) (this.log.topK[k] as Map<string, number>).set(r.symbol, minute);
    });
    const nowActive = new Set<string>(mdw.getActiveSymbols());
    for (const sym of nowActive) {
      if (!this.everActive.has(sym)) { this.everActive.add(sym); this.log.promoted.set(sym, minute); }
      if (!this.joinedAt.has(sym)) this.joinedAt.set(sym, nowMs);
    }
    for (const [sym, t] of [...this.joinedAt]) if (!nowActive.has(sym)) { this.lifetimes.push({ symbol: sym, joined: t, left: nowMs }); this.joinedAt.delete(sym); }
    if (minute % 15 === 0) this.samples.push({ minute, active: nowActive.size, rescueHolders: mdw.getActiveTemporaryRescues().length, evictable: mdw.getEvictionEligibleDynamicSymbols().length });
  }

  activeSymbols(): string[] { return this.mods.mdw.getActiveSymbols(); }

  async finish(): Promise<{ blockedProviderCalls: number; unsupported: string[] }> {
    const nowActiveSyms = new Set<string>(this.mods.mdw.getActiveSymbols());
    void nowActiveSyms;
    for (const [sym, t] of this.joinedAt) this.lifetimes.push({ symbol: sym, joined: t, left: null });
    const blocked = this.mods.alpacaTls.getBlockedSyntheticAlpacaCalls().length;
    for (const r of this.restore.reverse()) { try { r(); } catch { /* teardown */ } }
    this.restore = [];
    this.mods.Opp.resetOpportunityScanForTests(); this.mods.Snap.resetSnapshotScannerForTests(); this.mods.Alloc.resetBroadUniverseAllocatorForTests(); this.mods.MUS.resetMarketUniverseScannerForTests();
    return { blockedProviderCalls: blocked, unsupported: this.providerRef?.unsupported ?? [] };
  }

  async scoreAgainstOracle() {
    const { buildTruth, scoreDiscovery } = await import('./OpportunityOracle');
    const truth = buildTruth(this.market);
    const score = scoreDiscovery(truth, this.log as any, new Set(this.market.startingWatchlist));
    return { truth, score };
  }
}
