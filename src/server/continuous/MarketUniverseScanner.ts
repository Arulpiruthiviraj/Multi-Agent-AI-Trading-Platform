/**
 * Broad-universe candidate source for OpportunityDiscovery. Default OFF
 * (ARGUS_BROAD_UNIVERSE_ENABLED). Read-only Alpaca metadata/market-data calls only - never
 * imports EventBus, OMS, RiskEngine, or BrokerManager, and never emits TRADE_IDEA_GENERATED or
 * WATCHLIST_SUBSCRIBE_REQUESTED itself. Produces a plain, liquidity/price/spread-screened symbol
 * list that OpportunityDiscovery.getOpportunityScanUniverse() merges in and runs through the
 * exact same evaluateOpportunityCandidate() gate the fixed seed/watch lists already go through.
 *
 * Three-stage funnel, each stage cheaper than the last relative to a full market scan:
 *  1) fetchTradableAssets() - Alpaca's real tradable-assets list (thousands of rows), cached for
 *     broadUniverseAssetsCacheTtlMs since exchange listings change rarely intraday.
 *  2) screenAssets() - batched market-data snapshots (price/1-day volume/spread) against every
 *     tradable asset, filtered by passesScreen() down to a much smaller shortlist.
 *  3) fetchAvgDailyVolumeShares() - only for stage-2 survivors (not all thousands of assets): a
 *     real broadUniverseAdvLookbackDays-day average volume in shares via Alpaca's batched
 *     multi-symbol bars endpoint - a genuine ADV, not a fabricated one from a single day's bar.
 *     Symbols a batch fails to return bars for are excluded (fail-closed), not assumed liquid.
 * Final candidate list is ranked by dollar volume descending and capped at broadUniverseMaxCandidates.
 */
import { continuousIntelligence, isBroadUniverseEnabled, isMoversEnabled } from '../config/continuousIntelligence';
import { networkEndpoints } from '../config/networkEndpoints';
import { alpacaFetch } from '../core/alpacaTls';
import { logErrorSafely } from '../core/SecretRedaction';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';

interface AlpacaAsset {
  symbol: string;
  exchange: string;
  status: string;
  tradable: boolean;
  class: string;
}

interface AlpacaSnapshot {
  symbol: string;
  price: number;
  dollarVolume: number;
  spreadBps: number | null;
}

export interface BroadUniverseStats {
  ran: boolean;
  enabled: boolean;
  assetsFetched: number;
  screened: number;
  candidates: number;
  error: string | null;
  at: string;
}

let assetsCache: { fetchedAt: number; symbols: string[] } | null = null;
let snapshotCache: { fetchedAt: number; symbols: string[] } | null = null;
let inFlight = false;
let lastStats: BroadUniverseStats = {
  ran: false,
  enabled: false,
  assetsFetched: 0,
  screened: 0,
  candidates: 0,
  error: null,
  at: new Date(0).toISOString(),
};

function authHeaders(): Record<string, string> {
  return {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY || '',
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY || '',
  };
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await alpacaFetch(url, { headers: authHeaders(), signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Alpaca request failed ${res.status} for ${url}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Real Alpaca tradable-assets list, cached. Filters to active/tradable US equities on allowed exchanges. */
export async function fetchTradableAssets(): Promise<string[]> {
  const now = Date.now();
  if (assetsCache && now - assetsCache.fetchedAt < continuousIntelligence.broadUniverseAssetsCacheTtlMs) {
    return assetsCache.symbols;
  }
  const allowed = new Set(continuousIntelligence.broadUniverseAllowedExchanges);
  const url = `${networkEndpoints.broker.alpaca.paperBaseUrl}/v2/assets?status=active&asset_class=us_equity`;
  const assets = await fetchJson<AlpacaAsset[]>(url, 15000);
  const symbols = assets
    .filter((a) => a.tradable && a.status === 'active' && allowed.has(a.exchange))
    .map((a) => a.symbol.trim().toUpperCase())
    .filter(Boolean);
  assetsCache = { fetchedAt: now, symbols };
  return symbols;
}

/**
 * Batched snapshot screen: price range, dollar-volume floor, spread ceiling. Returns symbols
 * ranked by dollar volume descending, capped at broadUniverseMaxCandidates. Never throws for a
 * single bad batch - a failed batch is just excluded, not fatal to the whole screen.
 */
export async function screenAssets(symbols: string[]): Promise<AlpacaSnapshot[]> {
  const batchSize = continuousIntelligence.broadUniverseSnapshotBatchSize;
  const results: AlpacaSnapshot[] = [];
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const url = `${networkEndpoints.broker.alpaca.dataBaseUrl}/v2/stocks/snapshots?symbols=${batch.join(',')}&feed=iex`;
    try {
      const raw = await fetchJson<Record<string, any>>(url, 15000);
      for (const symbol of batch) {
        const snap = raw[symbol];
        const price = snap?.latestTrade?.p ?? snap?.dailyBar?.c;
        const volume = snap?.dailyBar?.v;
        const bid = snap?.latestQuote?.bp;
        const ask = snap?.latestQuote?.ap;
        if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) continue;
        if (typeof volume !== 'number' || !Number.isFinite(volume) || volume <= 0) continue;
        const dollarVolume = price * volume;
        const spreadBps = (typeof bid === 'number' && typeof ask === 'number' && bid > 0 && ask > 0)
          ? ((ask - bid) / ((ask + bid) / 2)) * 10000
          : null;
        results.push({ symbol, price, dollarVolume, spreadBps });
      }
    } catch (e) {
      logErrorSafely('[MarketUniverseScanner] snapshot batch failed', e);
    }
  }
  return results;
}

export type ScreenRejectReason = 'PRICE' | 'DOLLAR_VOLUME' | 'SPREAD';

/** Real Phase 18 finding: a symbol that failed this screen previously just vanished from the
 *  candidate list with zero record of why - the exact gap that made a real, verified market mover
 *  (FRVO, 2026-09-01 forensic audit) architecturally unexplainable after the fact. Returns the
 *  specific reason, not just a boolean, so the caller can log it. */
function evaluateScreen(snap: AlpacaSnapshot): { pass: boolean; reason: ScreenRejectReason | null } {
  const cfg = continuousIntelligence;
  if (snap.price < cfg.broadUniverseMinPrice || snap.price > cfg.broadUniverseMaxPrice) return { pass: false, reason: 'PRICE' };
  if (snap.dollarVolume < cfg.broadUniverseMinDollarVolume) return { pass: false, reason: 'DOLLAR_VOLUME' };
  if (snap.spreadBps != null && snap.spreadBps > cfg.broadUniverseMaxSpreadBps) return { pass: false, reason: 'SPREAD' };
  return { pass: true, reason: null };
}

function passesScreen(snap: AlpacaSnapshot): boolean {
  return evaluateScreen(snap).pass;
}

export type DiscoverySource = 'BROAD_UNIVERSE' | 'MARKET_MOVER';
export type DiscoveryRejectReason = ScreenRejectReason | 'ADV' | 'NO_SNAPSHOT_DATA' | 'RANK_CAP';

/**
 * Discovery Lineage Ledger, Phase A (2026-09-02 forensic audit follow-up). Real per-candidate
 * admit/reject decision, persisted via the existing observability_events pipeline (no new table) -
 * so a future FRVO-class miss becomes a real, queryable "candidate seen, rejected at stage X for
 * reason Y" row instead of an unexplainable disappearance. Never gates a trade, never emits
 * TRADE_IDEA_GENERATED or WATCHLIST_SUBSCRIBE_REQUESTED - purely descriptive of what this file's
 * own real screening already decided.
 */
function logDiscoveryCandidateDecision(input: {
  symbol: string;
  source: DiscoverySource;
  admitted: boolean;
  reason: DiscoveryRejectReason | null;
  price?: number | null;
  dollarVolume?: number | null;
  spreadBps?: number | null;
  advShares?: number | null;
}): void {
  observeSafe(() => {
    structuredLogger.info('discovery_candidate_decision', {
      category: 'DISCOVERY',
      eventType: input.admitted ? 'DISCOVERY_CANDIDATE_ADMITTED' : 'DISCOVERY_CANDIDATE_FILTERED',
      symbol: input.symbol,
      source: input.source,
      reason: input.reason,
      price: input.price ?? null,
      dollarVolume: input.dollarVolume ?? null,
      spreadBps: input.spreadBps ?? null,
      advShares: input.advShares ?? null,
    });
  });
}

interface AlpacaBarsResponse {
  bars: Record<string, Array<{ v?: number }>> | null;
}

/**
 * Real broadUniverseAdvLookbackDays-day average daily volume (shares) per symbol, via Alpaca's
 * batched multi-symbol bars endpoint. Only call this on an already-narrowed shortlist (stage-2
 * survivors), not the full tradable-assets list - same batching shape as screenAssets(). A batch
 * that fails, or a symbol with no bars in the response, is simply excluded from the returned map -
 * never assumed to pass, never a fabricated average.
 */
export async function fetchAvgDailyVolumeShares(symbols: string[]): Promise<Map<string, number>> {
  const batchSize = continuousIntelligence.broadUniverseSnapshotBatchSize;
  const days = continuousIntelligence.broadUniverseAdvLookbackDays;
  const out = new Map<string, number>();
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const url = `${networkEndpoints.broker.alpaca.dataBaseUrl}/v2/stocks/bars?symbols=${batch.join(',')}&timeframe=1Day&limit=${days}&adjustment=raw&feed=iex`;
    try {
      const raw = await fetchJson<AlpacaBarsResponse>(url, 15000);
      for (const symbol of batch) {
        const bars = raw.bars?.[symbol];
        if (!Array.isArray(bars) || bars.length === 0) continue;
        const volumes = bars
          .map((b) => b.v)
          .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0);
        if (volumes.length === 0) continue;
        out.set(symbol, volumes.reduce((a, b) => a + b, 0) / volumes.length);
      }
    } catch (e) {
      logErrorSafely('[MarketUniverseScanner] ADV batch failed', e);
    }
  }
  return out;
}

function passesAdvScreen(symbol: string, advMap: Map<string, number>): boolean {
  const adv = advMap.get(symbol);
  return adv != null && adv >= continuousIntelligence.broadUniverseMinAvgDailyVolumeShares;
}

/** Full refresh: fetch tradable assets, screen them, cache the resulting candidate symbol list. */
export async function refreshBroadUniverseCache(): Promise<BroadUniverseStats> {
  if (!isBroadUniverseEnabled()) {
    lastStats = { ran: false, enabled: false, assetsFetched: 0, screened: 0, candidates: 0, error: null, at: new Date().toISOString() };
    return lastStats;
  }
  if (inFlight) return lastStats;
  inFlight = true;
  try {
    const assets = await fetchTradableAssets();
    const screened = await screenAssets(assets);
    // Stage-1 (price/dollar-volume/spread) rejections are not logged per-symbol here - the
    // tradable-assets list is thousands of rows, and this stage runs only every
    // broadUniverseAssetsCacheTtlMs (24h), so per-symbol logging here would be a real
    // observability-volume cost for comparatively low decision value. Stage-2 (ADV, below) is
    // already narrowed to price/volume/spread survivors and IS logged per-symbol.
    const stage2 = screened.filter(passesScreen);
    const advMap = await fetchAvgDailyVolumeShares(stage2.map((s) => s.symbol));
    const advPassers = stage2.filter((s) => passesAdvScreen(s.symbol, advMap));
    const passing = advPassers
      .sort((a, b) => b.dollarVolume - a.dollarVolume)
      .slice(0, continuousIntelligence.broadUniverseMaxCandidates)
      .map((s) => s.symbol);
    const passingSet = new Set(passing);
    for (const s of stage2) {
      const admitted = passingSet.has(s.symbol);
      // Distinguish an outright ADV-floor failure from a candidate that cleared every real
      // liquidity gate but still lost the final dollar-volume-desc rank cutoff
      // (broadUniverseMaxCandidates) - these are different, real reasons, not the same one.
      const reason: DiscoveryRejectReason | null = admitted ? null : (passesAdvScreen(s.symbol, advMap) ? 'RANK_CAP' : 'ADV');
      logDiscoveryCandidateDecision({
        symbol: s.symbol, source: 'BROAD_UNIVERSE', admitted, reason,
        price: s.price, dollarVolume: s.dollarVolume, spreadBps: s.spreadBps, advShares: advMap.get(s.symbol) ?? null,
      });
    }
    snapshotCache = { fetchedAt: Date.now(), symbols: passing };
    lastStats = {
      ran: true,
      enabled: true,
      assetsFetched: assets.length,
      screened: screened.length,
      candidates: passing.length,
      error: null,
      at: new Date().toISOString(),
    };
    return lastStats;
  } catch (e: any) {
    logErrorSafely('[MarketUniverseScanner] refresh failed', e);
    lastStats = {
      ran: true,
      enabled: true,
      assetsFetched: 0,
      screened: 0,
      candidates: snapshotCache?.symbols.length || 0,
      error: e?.message || String(e),
      at: new Date().toISOString(),
    };
    return lastStats;
  } finally {
    inFlight = false;
  }
}

/** Synchronous read of whatever the last successful refresh produced. Empty until a refresh has run. */
export function getCachedBroadUniverseSymbols(): string[] {
  if (!isBroadUniverseEnabled()) return [];
  const now = Date.now();
  if (!snapshotCache || now - snapshotCache.fetchedAt > continuousIntelligence.broadUniverseSnapshotCacheTtlMs) {
    return snapshotCache?.symbols || [];
  }
  return snapshotCache.symbols;
}

export function getLastBroadUniverseStats(): BroadUniverseStats {
  return lastStats;
}

export function resetMarketUniverseScannerForTests(): void {
  assetsCache = null;
  snapshotCache = null;
  inFlight = false;
  lastStats = { ran: false, enabled: false, assetsFetched: 0, screened: 0, candidates: 0, error: null, at: new Date(0).toISOString() };
  moversCache = null;
  moversInFlight = false;
  lastMoverStats = { ran: false, enabled: false, gainersFetched: 0, losersFetched: 0, screened: 0, candidates: 0, error: null, at: new Date(0).toISOString() };
}

// ==========================================================================================
// Phase 17 (2026-09-01): real Alpaca top-gainers/losers screener - an additional discovery
// signal ("what's actually moving today"), separate from the liquidity-only broad universe
// above. Default OFF (ARGUS_MARKET_MOVERS_ENABLED). Same real, already-authenticated Alpaca
// API - no scraping, no new credential, no new external dependency. A raw mover symbol (Alpaca's
// real /v1beta1/screener/stocks/movers response includes plenty of sub-$1 warrants and other
// illiquid names - confirmed live) is never merged into the scan universe unfiltered: it must
// still clear the exact same passesScreen()/passesAdvScreen() liquidity gates every broad-universe
// candidate already has to clear. This only ever feeds WATCHLIST_SUBSCRIBE_REQUESTED-style
// candidates into OpportunityDiscovery's existing evaluateOpportunityCandidate() gate - it never
// emits TRADE_IDEA_GENERATED, never calls placeOrder, and never bypasses ChiefTrader/RiskEngine.
// ==========================================================================================

interface AlpacaMover {
  symbol: string;
  price: number;
  change: number;
  percent_change: number;
}

interface AlpacaMoversResponse {
  gainers: AlpacaMover[];
  losers: AlpacaMover[];
}

export interface MoverScanStats {
  ran: boolean;
  enabled: boolean;
  gainersFetched: number;
  losersFetched: number;
  screened: number;
  candidates: number;
  error: string | null;
  at: string;
}

let moversCache: { fetchedAt: number; symbols: string[] } | null = null;
let moversInFlight = false;
let lastMoverStats: MoverScanStats = {
  ran: false, enabled: false, gainersFetched: 0, losersFetched: 0, screened: 0, candidates: 0, error: null, at: new Date(0).toISOString(),
};

/** Real Alpaca top-gainers/losers screener - the same account credentials as every other Alpaca
 *  call in this file, no scraping. Returns raw symbols (deduped, uppercased) - unscreened. */
export async function fetchTopMovers(): Promise<{ symbols: string[]; gainersFetched: number; losersFetched: number }> {
  const top = continuousIntelligence.moversFetchTopNPerSide;
  const url = `${networkEndpoints.broker.alpaca.dataBaseUrl}/v1beta1/screener/stocks/movers?top=${top}`;
  const raw = await fetchJson<AlpacaMoversResponse>(url, 15000);
  const gainers = Array.isArray(raw.gainers) ? raw.gainers : [];
  const losers = Array.isArray(raw.losers) ? raw.losers : [];
  const symbols = [...new Set(
    [...gainers, ...losers].map((m) => String(m.symbol || '').trim().toUpperCase()).filter(Boolean),
  )];
  return { symbols, gainersFetched: gainers.length, losersFetched: losers.length };
}

/** Full refresh: fetch real movers, screen them through the same liquidity/ADV gates as the
 *  broad universe, cache the resulting candidate symbol list. */
export async function refreshMoversCache(): Promise<MoverScanStats> {
  if (!isMoversEnabled()) {
    lastMoverStats = { ran: false, enabled: false, gainersFetched: 0, losersFetched: 0, screened: 0, candidates: 0, error: null, at: new Date().toISOString() };
    return lastMoverStats;
  }
  if (moversInFlight) return lastMoverStats;
  moversInFlight = true;
  try {
    const { symbols, gainersFetched, losersFetched } = await fetchTopMovers();
    const screened = await screenAssets(symbols);
    // Movers is a small, bounded set (moversFetchTopNPerSide * 2 at most) refreshed every
    // moversCacheTtlMs (5 min) - unlike the thousands-of-assets broad-universe scan, every decision
    // here is cheap to log per-symbol, and this is exactly the funnel a real, verified market mover
    // (FRVO, 2026-09-01 forensic audit) came through before disappearing without a trace.
    const screenedSymbols = new Set(screened.map((s) => s.symbol));
    for (const symbol of symbols) {
      if (!screenedSymbols.has(symbol)) {
        logDiscoveryCandidateDecision({ symbol, source: 'MARKET_MOVER', admitted: false, reason: 'NO_SNAPSHOT_DATA' });
      }
    }
    const stage2: AlpacaSnapshot[] = [];
    for (const s of screened) {
      const result = evaluateScreen(s);
      if (result.pass) {
        stage2.push(s);
      } else {
        logDiscoveryCandidateDecision({ symbol: s.symbol, source: 'MARKET_MOVER', admitted: false, reason: result.reason, price: s.price, dollarVolume: s.dollarVolume, spreadBps: s.spreadBps });
      }
    }
    const advMap = await fetchAvgDailyVolumeShares(stage2.map((s) => s.symbol));
    for (const s of stage2) {
      const admitted = passesAdvScreen(s.symbol, advMap);
      logDiscoveryCandidateDecision({
        symbol: s.symbol, source: 'MARKET_MOVER', admitted, reason: admitted ? null : 'ADV',
        price: s.price, dollarVolume: s.dollarVolume, spreadBps: s.spreadBps, advShares: advMap.get(s.symbol) ?? null,
      });
    }
    const passing = stage2
      .filter((s) => passesAdvScreen(s.symbol, advMap))
      .sort((a, b) => b.dollarVolume - a.dollarVolume)
      .map((s) => s.symbol);
    moversCache = { fetchedAt: Date.now(), symbols: passing };
    lastMoverStats = {
      ran: true, enabled: true, gainersFetched, losersFetched, screened: screened.length, candidates: passing.length, error: null, at: new Date().toISOString(),
    };
    return lastMoverStats;
  } catch (e: any) {
    logErrorSafely('[MarketUniverseScanner] movers refresh failed', e);
    lastMoverStats = {
      ran: true, enabled: true, gainersFetched: 0, losersFetched: 0, screened: 0, candidates: moversCache?.symbols.length || 0, error: e?.message || String(e), at: new Date().toISOString(),
    };
    return lastMoverStats;
  } finally {
    moversInFlight = false;
  }
}

/** Synchronous read of whatever the last successful movers refresh produced. Empty until a refresh has run. */
export function getCachedMoverSymbols(): string[] {
  if (!isMoversEnabled()) return [];
  const now = Date.now();
  if (!moversCache || now - moversCache.fetchedAt > continuousIntelligence.moversCacheTtlMs) {
    return moversCache?.symbols || [];
  }
  return moversCache.symbols;
}

export function getLastMoverScanStats(): MoverScanStats {
  return lastMoverStats;
}

export class MarketUniverseScannerWorker {
  private intervalId: NodeJS.Timeout | null = null;
  private moversIntervalId: NodeJS.Timeout | null = null;

  start(): void {
    if (!isBroadUniverseEnabled()) {
      console.log('[MarketUniverseScanner] ARGUS_BROAD_UNIVERSE_ENABLED is not true - idle.');
    } else if (!this.intervalId) {
      void refreshBroadUniverseCache();
      this.intervalId = setInterval(() => {
        void refreshBroadUniverseCache();
      }, continuousIntelligence.broadUniverseAssetsCacheTtlMs);
      console.log('[MarketUniverseScanner] Broad-universe refresh started.');
    }
    if (!isMoversEnabled()) {
      console.log('[MarketUniverseScanner] ARGUS_MARKET_MOVERS_ENABLED is not true - idle.');
    } else if (!this.moversIntervalId) {
      void refreshMoversCache();
      this.moversIntervalId = setInterval(() => {
        void refreshMoversCache();
      }, continuousIntelligence.moversCacheTtlMs);
      console.log('[MarketUniverseScanner] Market-movers refresh started.');
    }
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.moversIntervalId) {
      clearInterval(this.moversIntervalId);
      this.moversIntervalId = null;
    }
  }
}

export const marketUniverseScannerWorker = new MarketUniverseScannerWorker();
