/**
 * Alpaca multi-symbol REST snapshot scanner (IEX).
 * Ranks a liquid universe by intraday momentum — never opens a WebSocket, never emits
 * TRADE_IDEA_GENERATED, never imports OMS / RiskEngine / BrokerManager.
 *
 * Hot-swap still goes through WATCHLIST_SUBSCRIBE_REQUESTED → MarketDataWorker (cap 12).
 */
import { continuousIntelligence } from '../config/continuousIntelligence';
import { networkEndpoints } from '../config/networkEndpoints';
import { alpacaFetch } from '../core/alpacaTls';
import { logErrorSafely } from '../core/SecretRedaction';
import { looksLikeListedTicker } from '../ai/AIOutputValidator';
import { getTradingTimeHHMM, TRADING_TIMEZONE } from '../core/TradingCalendar';
import { isEtTimeInWindow } from '../services/campaignIntraday';

export interface SnapshotScoreInput {
  symbol: string;
  /** Close used for % change (minuteBar.c preferred). */
  last: number;
  prevClose: number;
  minuteHigh: number | null;
  minuteLow: number | null;
  minuteClose: number | null;
  dailyVolume: number | null;
  prevDayVolume: number | null;
}

export interface SnapshotCandidate {
  symbol: string;
  intradayPctChange: number;
  rangeExpansion: number;
  relativeVolume: number;
  momentumScore: number;
}

export interface SnapshotScanStats {
  ran: boolean;
  rth: boolean;
  scanned: number;
  ranked: number;
  top: Array<{ symbol: string; momentumScore: number; intradayPctChange: number; relativeVolume: number }>;
  /** Sum of Alpaca snapshot batch HTTP round-trips for the last refresh. */
  latencyMs: number | null;
  /** Last HTTP status from a successful or failed batch (null if none). */
  lastHttpStatus: number | null;
  at: string;
  error: string | null;
}

const RTH_SESSION_MINUTES = 390; // 09:30–16:00 ET
const SCORE_WEIGHT_PCT = 0.5;
const SCORE_WEIGHT_RVOL = 0.3;
const SCORE_WEIGHT_RANGE = 0.2;

let lastRanked: SnapshotCandidate[] = [];
let lastScoreBySymbol = new Map<string, number>();
let lastStats: SnapshotScanStats = {
  ran: false,
  rth: false,
  scanned: 0,
  ranked: 0,
  top: [],
  latencyMs: null,
  lastHttpStatus: null,
  at: new Date(0).toISOString(),
  error: null,
};

function alpacaAuthHeaders(): Record<string, string> {
  const keyId = process.env.APCA_API_KEY_ID || process.env.ALPACA_API_KEY || '';
  const secret = process.env.APCA_API_SECRET_KEY || process.env.ALPACA_SECRET_KEY || '';
  return {
    'APCA-API-KEY-ID': keyId,
    'APCA-API-SECRET-KEY': secret,
  };
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<{ data: T; status: number; latencyMs: number }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await alpacaFetch(url, { headers: alpacaAuthHeaders(), signal: controller.signal });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const err = new Error(`Alpaca snapshot request failed ${res.status}`) as Error & { status?: number; latencyMs?: number };
      err.status = res.status;
      err.latencyMs = latencyMs;
      throw err;
    }
    return { data: (await res.json()) as T, status: res.status, latencyMs };
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Weekday 09:30–16:00 America/New_York (ignores exchange holidays — fail-open for scan cadence). */
export function isSnapshotScannerRth(now: Date = new Date()): boolean {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: TRADING_TIMEZONE,
    weekday: 'short',
  }).format(now);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return isEtTimeInWindow(getTradingTimeHHMM(now), '09:30', '16:00');
}

/** Minutes since 09:30 ET, clamped to [1, 390]. */
export function minutesSinceRthOpen(now: Date = new Date()): number {
  const hhmm = getTradingTimeHHMM(now);
  const [h, m] = hhmm.split(':').map((x) => Number(x));
  const mins = h * 60 + m;
  const open = 9 * 60 + 30;
  return Math.max(1, Math.min(RTH_SESSION_MINUTES, mins - open));
}

export function expectedVolumeAtTimeOfDay(
  prevDayVolume: number | null,
  now: Date = new Date(),
): number | null {
  if (prevDayVolume == null || !Number.isFinite(prevDayVolume) || prevDayVolume <= 0) return null;
  const frac = minutesSinceRthOpen(now) / RTH_SESSION_MINUTES;
  return prevDayVolume * Math.max(0.02, frac);
}

/**
 * Pure scoring — used by unit tests with mocked bar fields.
 * intradayPctChange is in percent points (e.g. 2.5 = +2.5%).
 */
export function scoreSnapshotCandidate(input: SnapshotScoreInput, now: Date = new Date()): SnapshotCandidate | null {
  const symbol = looksLikeListedTicker(input.symbol);
  if (!symbol) return null;
  if (!(input.last > 0) || !(input.prevClose > 0)) return null;

  const intradayPctChange = ((input.last - input.prevClose) / input.prevClose) * 100;

  let rangeExpansion = 0;
  const hi = input.minuteHigh;
  const lo = input.minuteLow;
  const mid = input.minuteClose ?? input.last;
  if (
    typeof hi === 'number' && typeof lo === 'number'
    && Number.isFinite(hi) && Number.isFinite(lo) && mid > 0
  ) {
    rangeExpansion = Math.max(0, (hi - lo) / mid);
  }

  const expected = expectedVolumeAtTimeOfDay(input.prevDayVolume, now);
  let relativeVolume = 0;
  if (input.dailyVolume != null && input.dailyVolume > 0 && expected != null && expected > 0) {
    relativeVolume = input.dailyVolume / expected;
  } else if (
    input.dailyVolume != null && input.dailyVolume > 0
    && input.prevDayVolume != null && input.prevDayVolume > 0
  ) {
    relativeVolume = input.dailyVolume / input.prevDayVolume;
  }

  const momentumScore =
    (Math.abs(intradayPctChange) * SCORE_WEIGHT_PCT)
    + (relativeVolume * SCORE_WEIGHT_RVOL)
    + (rangeExpansion * SCORE_WEIGHT_RANGE);

  return {
    symbol,
    intradayPctChange,
    rangeExpansion,
    relativeVolume,
    momentumScore,
  };
}

export function getSnapshotScanUniverse(): string[] {
  const names = [
    ...continuousIntelligence.seedSymbols,
    ...continuousIntelligence.watchUniverseSymbols,
    ...continuousIntelligence.campaignOpeningSurgeSymbols,
    ...continuousIntelligence.momentumScanUniverseSymbols,
  ];
  return [...new Set(names.map((s) => s.trim().toUpperCase()).filter((s) => looksLikeListedTicker(s)))];
}

function anchorSet(): Set<string> {
  return new Set(
    continuousIntelligence.coreStreamingSymbols.map((s) => s.trim().toUpperCase()).filter(Boolean),
  );
}

function parseRawSnapshot(symbol: string, snap: Record<string, unknown> | undefined): SnapshotScoreInput | null {
  if (!snap) return null;
  const minuteBar = snap.minuteBar as { c?: number; h?: number; l?: number; v?: number } | undefined;
  const dailyBar = snap.dailyBar as { c?: number; v?: number } | undefined;
  const prevDailyBar = snap.prevDailyBar as { c?: number; v?: number } | undefined;
  const latestTrade = snap.latestTrade as { p?: number } | undefined;

  const prevClose =
    typeof prevDailyBar?.c === 'number' && prevDailyBar.c > 0 ? prevDailyBar.c : null;
  if (prevClose == null) return null;

  const last =
    (typeof minuteBar?.c === 'number' && minuteBar.c > 0 ? minuteBar.c : null)
    ?? (typeof latestTrade?.p === 'number' && latestTrade.p > 0 ? latestTrade.p : null)
    ?? (typeof dailyBar?.c === 'number' && dailyBar.c > 0 ? dailyBar.c : null);
  if (last == null) return null;

  return {
    symbol,
    last,
    prevClose,
    minuteHigh: typeof minuteBar?.h === 'number' ? minuteBar.h : null,
    minuteLow: typeof minuteBar?.l === 'number' ? minuteBar.l : null,
    minuteClose: typeof minuteBar?.c === 'number' ? minuteBar.c : null,
    dailyVolume: typeof dailyBar?.v === 'number' ? dailyBar.v : null,
    prevDayVolume: typeof prevDailyBar?.v === 'number' ? prevDailyBar.v : null,
  };
}

/** Fetch + rank full universe. Safe to call anytime (REST only). */
export async function refreshSnapshotRanks(now: Date = new Date()): Promise<SnapshotCandidate[]> {
  const universe = getSnapshotScanUniverse();
  const batchSize = continuousIntelligence.broadUniverseSnapshotBatchSize;
  const scored: SnapshotCandidate[] = [];
  let scanned = 0;
  let latencyMs = 0;
  let lastHttpStatus: number | null = null;

  try {
    for (let i = 0; i < universe.length; i += batchSize) {
      const batch = universe.slice(i, i + batchSize);
      const url =
        `${networkEndpoints.broker.alpaca.dataBaseUrl}/v2/stocks/snapshots`
        + `?symbols=${batch.join(',')}&feed=iex`;
      try {
        const { data: raw, status, latencyMs: batchMs } = await fetchJson<Record<string, Record<string, unknown>>>(url, 15000);
        latencyMs += batchMs;
        lastHttpStatus = status;
        for (const symbol of batch) {
          const input = parseRawSnapshot(symbol, raw[symbol]);
          if (!input) continue;
          scanned += 1;
          const row = scoreSnapshotCandidate(input, now);
          if (row) scored.push(row);
        }
      } catch (e) {
        const err = e as Error & { status?: number; latencyMs?: number };
        if (typeof err.latencyMs === 'number') latencyMs += err.latencyMs;
        if (typeof err.status === 'number') lastHttpStatus = err.status;
        logErrorSafely('[SnapshotScanner] snapshot batch failed', e);
      }
    }

    scored.sort((a, b) => b.momentumScore - a.momentumScore);
    lastRanked = scored;
    lastScoreBySymbol = new Map(scored.map((r) => [r.symbol, r.momentumScore]));
    lastStats = {
      ran: true,
      rth: isSnapshotScannerRth(now),
      scanned,
      ranked: scored.length,
      top: scored.slice(0, 12).map((r) => ({
        symbol: r.symbol,
        momentumScore: r.momentumScore,
        intradayPctChange: r.intradayPctChange,
        relativeVolume: r.relativeVolume,
      })),
      latencyMs,
      lastHttpStatus,
      at: new Date().toISOString(),
      error: null,
    };
    if (latencyMs > 0) {
      console.log(
        `[SnapshotScanner] ranked ${scored.length}/${scanned} symbols in ${latencyMs}ms `
        + `(http=${lastHttpStatus ?? 'n/a'})`,
      );
    }
    return scored;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logErrorSafely('[SnapshotScanner] refresh failed', e);
    lastStats = {
      ran: true,
      rth: isSnapshotScannerRth(now),
      scanned,
      ranked: lastRanked.length,
      top: lastStats.top,
      latencyMs,
      lastHttpStatus,
      at: new Date().toISOString(),
      error: msg,
    };
    return lastRanked;
  }
}

/**
 * Top dynamic (non-anchor) momentum candidates for WebSocket hot-swap.
 * Refreshes from Alpaca REST unless `opts.cachedOnly`.
 */
export async function getTopMomentumCandidates(
  count: number = continuousIntelligence.snapshotTopCandidates,
  opts: { cachedOnly?: boolean; now?: Date } = {},
): Promise<SnapshotCandidate[]> {
  const now = opts.now ?? new Date();
  if (!opts.cachedOnly) {
    await refreshSnapshotRanks(now);
  }
  const anchors = anchorSet();
  return lastRanked.filter((r) => !anchors.has(r.symbol)).slice(0, Math.max(0, count));
}

export function getLastSnapshotScore(symbol: string): number | null {
  const v = lastScoreBySymbol.get(String(symbol || '').trim().toUpperCase());
  return typeof v === 'number' ? v : null;
}

export function getLastSnapshotScanStats(): SnapshotScanStats {
  return lastStats;
}

/** Test helper: inject ranked rows without network. */
export function setSnapshotRanksForTests(rows: SnapshotCandidate[]): void {
  lastRanked = [...rows].sort((a, b) => b.momentumScore - a.momentumScore);
  lastScoreBySymbol = new Map(lastRanked.map((r) => [r.symbol, r.momentumScore]));
  lastStats = {
    ran: true,
    rth: true,
    scanned: rows.length,
    ranked: rows.length,
    top: lastRanked.slice(0, 12).map((r) => ({
      symbol: r.symbol,
      momentumScore: r.momentumScore,
      intradayPctChange: r.intradayPctChange,
      relativeVolume: r.relativeVolume,
    })),
    latencyMs: 0,
    lastHttpStatus: 200,
    at: new Date().toISOString(),
    error: null,
  };
}

export function resetSnapshotScannerForTests(): void {
  lastRanked = [];
  lastScoreBySymbol = new Map();
  lastStats = {
    ran: false,
    rth: false,
    scanned: 0,
    ranked: 0,
    top: [],
    latencyMs: null,
    lastHttpStatus: null,
    at: new Date(0).toISOString(),
    error: null,
  };
}
