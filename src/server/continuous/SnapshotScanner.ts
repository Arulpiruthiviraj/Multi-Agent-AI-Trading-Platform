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
import { normalizeAndValidateSymbols } from '../core/symbolNormalization';
import { getTradingTimeHHMM, TRADING_TIMEZONE, getTradingDateStr } from '../core/TradingCalendar';
import { classifyMarketSession } from '../replay/marketSession';
import type { ResearchBar } from '../research/ohlcvTypes';

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
  /** Phase 4C (Composable Ranking) - the daily bar's real open price, for gap-behavior scoring. Optional so existing callers/fixtures built before this field existed are unaffected. */
  open?: number | null;
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
/** ComposableRanking's own persisted finalScore (0-1) per symbol from the most recent ranking
 *  cycle - see getLastComposableScore() below for why this exists. */
let lastComposableScoreBySymbol = new Map<string, number>();
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

/**
 * Weekday 09:30-16:00 America/New_York (ignores exchange holidays — fail-open for scan cadence).
 * Delegates to classifyMarketSession() rather than re-deriving weekday/minute math a second time
 * (2026-09-05 session-representation consolidation - see
 * docs/architecture/ARGUS_ARCHITECTURE.md (Premarket / Session-Aware Trading Architecture section) §2.2, representation #6). Behavior
 * is unchanged: classifyMarketSession's REGULAR branch is the identical [09:30, 16:00) weekday
 * window this function always used, verified against isEtTimeInWindow's own inclusive-start/
 * exclusive-end semantics before this refactor.
 */
export function isSnapshotScannerRth(now: Date = new Date()): boolean {
  return classifyMarketSession(now.getTime(), TRADING_TIMEZONE, false) === 'REGULAR';
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
  return normalizeAndValidateSymbols(names);
}

function anchorSet(): Set<string> {
  return new Set(
    continuousIntelligence.coreStreamingSymbols.map((s) => s.trim().toUpperCase()).filter(Boolean),
  );
}

function parseRawSnapshot(symbol: string, snap: Record<string, unknown> | undefined): SnapshotScoreInput | null {
  if (!snap) return null;
  const minuteBar = snap.minuteBar as { c?: number; h?: number; l?: number; v?: number } | undefined;
  const dailyBar = snap.dailyBar as { c?: number; v?: number; o?: number } | undefined;
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
    open: typeof dailyBar?.o === 'number' ? dailyBar.o : null,
  };
}

/** Fetch + rank full universe. Safe to call anytime (REST only). */
export async function refreshSnapshotRanks(now: Date = new Date()): Promise<SnapshotCandidate[]> {
  const universe = getSnapshotScanUniverse();
  const batchSize = continuousIntelligence.broadUniverseSnapshotBatchSize;
  const scored: SnapshotCandidate[] = [];
  const scoredInputs: SnapshotScoreInput[] = [];
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
          if (row) {
            scored.push(row);
            scoredInputs.push(input);
          }
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

    // Phase 4C (Composable Ranking, 2026-08-26): additive, persisted parallel ranking cycle using
    // the SAME already-fetched snapshot data - no new network calls. Never affects lastRanked/
    // lastStats/getLastSnapshotScanStats()'s existing contract, and never throws into the caller.
    try {
      const marketSession = classifyMarketSession(now.getTime(), TRADING_TIMEZONE, true);
      const rankingInputs = scoredInputs.map((input, i) => ({
        symbol: input.symbol,
        last: input.last,
        prevClose: input.prevClose,
        open: input.open ?? null,
        prevOpen: null,
        minuteHigh: input.minuteHigh,
        minuteLow: input.minuteLow,
        minuteClose: input.minuteClose,
        dailyVolume: input.dailyVolume,
        prevDayVolume: input.prevDayVolume,
        rawMomentumPct: scored[i].intradayPctChange,
        rawRelativeVolume: scored[i].relativeVolume,
        rawRangeExpansion: scored[i].rangeExpansion,
      }));
      const { runRankingCycle } = await import('./ComposableRanking');
      const planDate = getTradingDateStr(now);
      const { buildTradePlanDrafts, persistTradePlanDrafts, getTradePlansForDate, revalidateTradePlan, persistRevalidation, emitTradePlanIdea } = await import('./TradePlanBuilder');

      let rankedCandidates = await runRankingCycle(rankingInputs, now, new Map(), marketSession);

      // Session-Aware Trading Architecture Phase 3 follow-up (2026-09-05): javaQuantScore's one
      // live wiring point - ONLY the once-per-trading-day PRE_MARKET plan-building cycle (never
      // every ~30s RTH tick, which would multiply Java HTTP + bar-fetch cost with no evidence yet
      // that it's worth that cost - see ComposableRanking.fetchJavaQuantScores' own doc comment).
      // A second runRankingCycle() call, bounded to the top-N candidates by the SAME deterministic
      // pre-score already computed above (no Java involvement in which symbols get picked), and
      // only when the Java core is actually enabled (isQuantJavaCoreEnabled - zero cost otherwise)
      // and no plan already exists for today (matches the existing "build once per day" gate below).
      if (marketSession === 'PRE_MARKET') {
        const existingForJava = await getTradePlansForDate(planDate);
        if (existingForJava.length === 0) {
          try {
            const { isQuantJavaCoreEnabled } = await import('../config/tradingSafety');
            if (isQuantJavaCoreEnabled()) {
              const topSymbols = scored.slice(0, continuousIntelligence.javaQuantScoreCandidateLimit).map((r) => r.symbol);
              if (topSymbols.length > 0) {
                const { historicalDataGateway } = await import('../engines/backtest/HistoricalDataGateway');
                const { LOOKBACK_DAYS, TIMEFRAME } = await import('../services/JavaQuantAdvisoryService');
                const endMs = now.getTime();
                const startMs = endMs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
                const javaQuantBarsBySymbol = new Map<string, ResearchBar[]>();
                await Promise.all(topSymbols.map(async (symbol) => {
                  try {
                    await historicalDataGateway.ensureBars(symbol, TIMEFRAME, startMs, endMs);
                    const bars = await historicalDataGateway.getBars(symbol, TIMEFRAME, startMs, endMs);
                    if (bars.length > 0) javaQuantBarsBySymbol.set(symbol, bars);
                  } catch (e) {
                    logErrorSafely(`[SnapshotScanner] Java quant bar fetch failed for ${symbol} (falls back to javaQuantScore unavailable for this symbol)`, e);
                  }
                }));
                if (javaQuantBarsBySymbol.size > 0) {
                  rankedCandidates = await runRankingCycle(rankingInputs, now, javaQuantBarsBySymbol, marketSession);
                }
              }
            }
          } catch (e) {
            logErrorSafely('[SnapshotScanner] javaQuantScore pre-market wiring failed (falls back to the ranking cycle without it)', e);
          }
        }
      }

      // Universal Opportunity Discovery follow-up (2026-09-03): expose the SAME already-computed
      // finalScore this cycle produced to blendedHotSwapScore() via getLastComposableScore() -
      // see that function's own comment for why this closes a real gap (finalScore previously had
      // zero influence on which symbols receive a market-data slot).
      lastComposableScoreBySymbol = new Map(rankedCandidates.map((r) => [r.symbol, r.finalScore]));

      // Phase 4E (Pre-Market TradePlan, 2026-08-27): additive, wrapped in the SAME try/catch as
      // the ranking cycle above - a failure here can never affect the existing scan/rank return
      // value. Never emits TRADE_IDEA_GENERATED, never imports OMS/RiskEngine/the order-placement
      // broker layer - see TradePlanBuilder.ts's own header for the full governance statement.
      const inputsBySymbol = new Map(rankingInputs.map((r) => [r.symbol, r]));
      const rankedBySymbol = new Map(rankedCandidates.map((r) => [r.symbol, r]));

      if (marketSession === 'PRE_MARKET') {
        const existing = await getTradePlansForDate(planDate);
        if (existing.length === 0) {
          const drafts = buildTradePlanDrafts(rankedCandidates, inputsBySymbol, planDate, now);
          await persistTradePlanDrafts(drafts);
          // 2026-09-05, explicit operator authorization (see TradePlanBuilder.ts's own header) -
          // one independent TRADE_IDEA_GENERATED vote per PRIMARY-tier draft. No-op (returns
          // emitted:false) unless ARGUS_TRADE_PLAN_IDEAS_ENABLED, Autobot, and the TradePlanBuilder
          // pipeline-agent toggle are all on - identical behavior to before this call existed for
          // every deployment that has not made this explicit choice.
          for (const draft of drafts) {
            emitTradePlanIdea(draft, inputsBySymbol.get(draft.symbol)?.last ?? null);
          }
        }
      } else if (marketSession === 'REGULAR') {
        const existing = await getTradePlansForDate(planDate);
        for (const plan of existing) {
          if (plan.status !== 'READY' && plan.status !== 'VALID' && plan.status !== 'REVALIDATING') continue;
          const outcome = revalidateTradePlan(
            { direction: plan.direction, invalidationLevel: plan.invalidationLevel, validUntil: plan.validUntil },
            inputsBySymbol.get(plan.symbol) ?? null,
            rankedBySymbol.get(plan.symbol) ?? null,
            now,
          );
          await persistRevalidation(plan.id, outcome, now, plan.status, {
            symbol: plan.symbol,
            direction: plan.direction as 'BUY' | 'SELL',
            confidence: plan.confidence,
          });
        }
      }

      // Phase 4F (Missed Opportunity Intelligence, 2026-08-27): additive, same try/catch as above.
      // Diagnostic only - classifies where a PROMOTE candidate stalled using existing telemetry;
      // never emits a trade idea, never affects sizing/consensus. See MissedOpportunityDetector.ts.
      const { runMissedOpportunityDetectionCycle } = await import('./MissedOpportunityDetector');
      const { marketDataWorker } = await import('../services/MarketDataWorker');
      await runMissedOpportunityDetectionCycle(
        rankedCandidates,
        new Set(marketDataWorker.getActiveSymbols()),
        continuousIntelligence.missedOpportunityLookbackMs,
        continuousIntelligence.missedOpportunityDetectionCooldownMs,
        continuousIntelligence.missedOpportunityEvaluationHorizonMinutes,
        now,
      );
    } catch (e) {
      logErrorSafely('[SnapshotScanner] composable ranking / trade plan / missed-opportunity cycle failed (does not affect the existing scan)', e);
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

/**
 * ComposableRanking's persisted finalScore (0-1) for this symbol from the most recent ranking
 * cycle, or null when unavailable (never fabricated as 0) - e.g. the composable ranking cycle
 * hasn't run yet this session, or this symbol wasn't part of the scanned universe this cycle.
 */
export function getLastComposableScore(symbol: string): number | null {
  const v = lastComposableScoreBySymbol.get(String(symbol || '').trim().toUpperCase());
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
  lastComposableScoreBySymbol = new Map();
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
