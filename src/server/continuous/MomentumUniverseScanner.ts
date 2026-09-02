/**
 * REST momentum ranking for Dynamic Universe rotation.
 * Uses Alpaca multi-symbol snapshots (not WebSocket). Never emits TRADE_IDEA_GENERATED,
 * never imports OMS / RiskEngine / BrokerManager. Hot-swap still goes through
 * WATCHLIST_SUBSCRIBE_REQUESTED → MarketDataWorker under maxActiveSubscriptions.
 */
import { continuousIntelligence } from '../config/continuousIntelligence';
import { networkEndpoints } from '../config/networkEndpoints';
import { alpacaFetch } from '../core/alpacaTls';
import { logErrorSafely } from '../core/SecretRedaction';
import { normalizeAndValidateSymbols } from '../core/symbolNormalization';
import { getNewsCatalysts } from '../services/NewsCatalystStore';
import { isEtTimeInWindow } from '../services/campaignIntraday';
import { getTradingTimeHHMM } from '../core/TradingCalendar';

export interface MomentumSnapshotMetrics {
  symbol: string;
  price: number;
  prevClose: number | null;
  todaysVolume: number | null;
  prevDayVolume: number | null;
  /** Signed intraday/gap change vs prior close. */
  changePct: number | null;
  /** Proxy RVOL: today's volume / prior day volume when both positive. */
  rvol: number | null;
  hasNewsCatalyst: boolean;
}

export interface MomentumRankRow extends MomentumSnapshotMetrics {
  score: number;
  pass: boolean;
  reasons: string[];
}

export interface MomentumScanStats {
  ran: boolean;
  inWindow: boolean;
  scanned: number;
  passed: number;
  top: Array<{ symbol: string; score: number; changePct: number | null; rvol: number | null }>;
  at: string;
  error: string | null;
}

let lastStats: MomentumScanStats = {
  ran: false,
  inWindow: false,
  scanned: 0,
  passed: 0,
  top: [],
  at: new Date(0).toISOString(),
  error: null,
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

export function isMomentumRotationWindow(now: Date = new Date()): boolean {
  if (!continuousIntelligence.momentumRotationEnabled) return false;
  const hhmm = getTradingTimeHHMM(now);
  return isEtTimeInWindow(
    hhmm,
    continuousIntelligence.momentumScanWindowStartEt,
    continuousIntelligence.momentumScanWindowEndEt,
  );
}

export function hasMomentumNewsCatalyst(symbol: string): boolean {
  const cats = getNewsCatalysts(symbol);
  return cats.some(
    (c) =>
      c.catalystStrength === 'HIGH'
      || (c.status === 'STAGED_FOR_OPEN' && c.catalystStrength !== 'LOW'),
  );
}

/** Pure filter + score for unit tests (no network). */
export function evaluateMomentumCandidate(m: MomentumSnapshotMetrics): MomentumRankRow {
  const minAbs = continuousIntelligence.momentumMinAbsChangePct;
  const minRvol = continuousIntelligence.momentumMinRvol;
  const reasons: string[] = [];
  const absChange = m.changePct != null && Number.isFinite(m.changePct) ? Math.abs(m.changePct) : null;
  const rvolOk = m.rvol != null && Number.isFinite(m.rvol) && m.rvol >= minRvol;
  const changeOk = absChange != null && absChange >= minAbs;

  if (!changeOk) reasons.push(`ABS_CHANGE_BELOW_${minAbs}`);
  else reasons.push(`ABS_CHANGE_${absChange!.toFixed(4)}`);
  if (!rvolOk) reasons.push(`RVOL_BELOW_${minRvol}`);
  else reasons.push(`RVOL_${m.rvol!.toFixed(2)}`);

  if (m.hasNewsCatalyst) reasons.push('NEWS_CATALYST');
  else if (continuousIntelligence.momentumRequireNewsCatalyst) {
    reasons.push('NEWS_CATALYST_REQUIRED');
  }

  const newsOk = !continuousIntelligence.momentumRequireNewsCatalyst || m.hasNewsCatalyst;
  const pass = changeOk && rvolOk && newsOk && m.price > 0;

  // Prefer large |%| + RVOL; news is a soft boost (never alone enough to pass).
  const changeScore = absChange != null ? Math.min(absChange / 0.05, 3) : 0;
  const rvolScore = m.rvol != null && m.rvol > 0 ? Math.min(m.rvol / 3, 3) : 0;
  const newsBoost = m.hasNewsCatalyst ? 0.5 : 0;
  const score = pass ? changeScore + rvolScore + newsBoost : 0;

  return { ...m, score, pass, reasons };
}

function parseSnapshot(symbol: string, snap: Record<string, unknown> | undefined): MomentumSnapshotMetrics | null {
  if (!snap) return null;
  const latestTrade = snap.latestTrade as { p?: number } | undefined;
  const dailyBar = snap.dailyBar as { c?: number; v?: number; o?: number } | undefined;
  const prevDailyBar = snap.prevDailyBar as { c?: number; v?: number } | undefined;
  const priceRaw = latestTrade?.p ?? dailyBar?.c;
  if (typeof priceRaw !== 'number' || !Number.isFinite(priceRaw) || priceRaw <= 0) return null;

  const prevClose =
    typeof prevDailyBar?.c === 'number' && Number.isFinite(prevDailyBar.c) && prevDailyBar.c > 0
      ? prevDailyBar.c
      : null;
  const todaysVolume =
    typeof dailyBar?.v === 'number' && Number.isFinite(dailyBar.v) && dailyBar.v >= 0
      ? dailyBar.v
      : null;
  const prevDayVolume =
    typeof prevDailyBar?.v === 'number' && Number.isFinite(prevDailyBar.v) && prevDailyBar.v > 0
      ? prevDailyBar.v
      : null;

  const changePct = prevClose != null ? (priceRaw - prevClose) / prevClose : null;
  const rvol =
    todaysVolume != null && prevDayVolume != null && prevDayVolume > 0
      ? todaysVolume / prevDayVolume
      : null;

  return {
    symbol,
    price: priceRaw,
    prevClose,
    todaysVolume,
    prevDayVolume,
    changePct,
    rvol,
    hasNewsCatalyst: hasMomentumNewsCatalyst(symbol),
  };
}

/** Batched Alpaca IEX snapshots → momentum metrics. Failed batches are skipped (fail-open per batch). */
export async function fetchMomentumSnapshots(symbols: string[]): Promise<MomentumSnapshotMetrics[]> {
  const batchSize = continuousIntelligence.broadUniverseSnapshotBatchSize;
  const unique = normalizeAndValidateSymbols(symbols);
  const results: MomentumSnapshotMetrics[] = [];
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    const url = `${networkEndpoints.broker.alpaca.dataBaseUrl}/v2/stocks/snapshots?symbols=${batch.join(',')}&feed=iex`;
    try {
      const raw = await fetchJson<Record<string, Record<string, unknown>>>(url, 15000);
      for (const symbol of batch) {
        const row = parseSnapshot(symbol, raw[symbol]);
        if (row) results.push(row);
      }
    } catch (e) {
      logErrorSafely('[MomentumUniverseScanner] snapshot batch failed', e);
    }
  }
  return results;
}

export function getMomentumScanUniverse(): string[] {
  const names = [
    ...continuousIntelligence.seedSymbols,
    ...continuousIntelligence.watchUniverseSymbols,
    ...continuousIntelligence.campaignOpeningSurgeSymbols,
    ...continuousIntelligence.momentumScanUniverseSymbols,
  ];
  return normalizeAndValidateSymbols(names);
}

/**
 * Rank liquid REST universe for hot-swap. Safe to call anytime; `inWindow` reflects whether
 * OpportunityDiscovery should spend hot-swap budget when the stream is already full.
 */
export async function rankMomentumUniverse(now: Date = new Date()): Promise<MomentumRankRow[]> {
  const inWindow = isMomentumRotationWindow(now);
  try {
    const universe = getMomentumScanUniverse();
    const snaps = await fetchMomentumSnapshots(universe);
    const ranked = snaps
      .map(evaluateMomentumCandidate)
      .filter((r) => r.pass)
      .sort((a, b) => b.score - a.score);
    lastStats = {
      ran: true,
      inWindow,
      scanned: snaps.length,
      passed: ranked.length,
      top: ranked.slice(0, 12).map((r) => ({
        symbol: r.symbol,
        score: r.score,
        changePct: r.changePct,
        rvol: r.rvol,
      })),
      at: new Date().toISOString(),
      error: null,
    };
    return ranked;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logErrorSafely('[MomentumUniverseScanner] rank failed', e);
    lastStats = {
      ran: true,
      inWindow,
      scanned: 0,
      passed: 0,
      top: [],
      at: new Date().toISOString(),
      error: msg,
    };
    return [];
  }
}

export function getLastMomentumScanStats(): MomentumScanStats {
  return lastStats;
}

export function resetMomentumScanForTests(): void {
  lastStats = {
    ran: false,
    inWindow: false,
    scanned: 0,
    passed: 0,
    top: [],
    at: new Date(0).toISOString(),
    error: null,
  };
}
