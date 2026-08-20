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
import { continuousIntelligence, isBroadUniverseEnabled } from '../config/continuousIntelligence';
import { networkEndpoints } from '../config/networkEndpoints';
import { alpacaFetch } from '../core/alpacaTls';
import { logErrorSafely } from '../core/SecretRedaction';

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

function passesScreen(snap: AlpacaSnapshot): boolean {
  const cfg = continuousIntelligence;
  if (snap.price < cfg.broadUniverseMinPrice || snap.price > cfg.broadUniverseMaxPrice) return false;
  if (snap.dollarVolume < cfg.broadUniverseMinDollarVolume) return false;
  if (snap.spreadBps != null && snap.spreadBps > cfg.broadUniverseMaxSpreadBps) return false;
  return true;
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
    const stage2 = screened.filter(passesScreen);
    const advMap = await fetchAvgDailyVolumeShares(stage2.map((s) => s.symbol));
    const passing = stage2
      .filter((s) => passesAdvScreen(s.symbol, advMap))
      .sort((a, b) => b.dollarVolume - a.dollarVolume)
      .slice(0, continuousIntelligence.broadUniverseMaxCandidates)
      .map((s) => s.symbol);
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
}

export class MarketUniverseScannerWorker {
  private intervalId: NodeJS.Timeout | null = null;

  start(): void {
    if (!isBroadUniverseEnabled()) {
      console.log('[MarketUniverseScanner] ARGUS_BROAD_UNIVERSE_ENABLED is not true - idle.');
      return;
    }
    if (this.intervalId) return;
    void refreshBroadUniverseCache();
    this.intervalId = setInterval(() => {
      void refreshBroadUniverseCache();
    }, continuousIntelligence.broadUniverseAssetsCacheTtlMs);
    console.log('[MarketUniverseScanner] Broad-universe refresh started.');
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

export const marketUniverseScannerWorker = new MarketUniverseScannerWorker();
