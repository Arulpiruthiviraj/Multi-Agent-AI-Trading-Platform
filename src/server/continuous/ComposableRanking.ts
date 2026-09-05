/**
 * Phase 4C (Composable Candidate Ranking, 2026-08-26). Replaces the previous single fused
 * `momentumScore` (SnapshotScanner.ts's scoreSnapshotCandidate) with independently observable,
 * independently persisted components, so an operator can always answer "why did this rank #3
 * while another ranked #89" from a specific row rather than a single opaque number.
 *
 * Governance:
 * - Discovery/ranking only. Never imports OMS/RiskEngine/BrokerManager, never emits
 *   TRADE_IDEA_GENERATED, never subscribes to a broker.
 * - A component with no real data source available (e.g. an unavailable field on the fetched
 *   snapshot) is marked { available: false, reason } and EXCLUDED from both the weighted-sum
 *   numerator and denominator - it is never silently treated as a zero score (a real zero score
 *   and "no data" are different things and must not be conflated, matching this session's own
 *   Phase 4B evidence-aware principle).
 * - Components requiring a data source this deployment does not have (corporate/earnings
 *   calendar, sector-relative-strength baskets, historical setup-quality backtesting, intraday
 *   bar-derived volatility) are deliberately NOT implemented here rather than faked - see the
 *   NOT_IMPLEMENTED_COMPONENTS list below, each with the concrete reason it is missing.
 */
import { db } from '../db';
import { newsClusters, agentPredictions, candidateRankings } from '../db/schema';
import { desc, gte, inArray } from 'drizzle-orm';
import { quantCoreBridge } from '../services/QuantCoreBridge';
import { FACTOR_CONFIDENCE_SCALE } from '../services/JavaQuantAdvisoryService';
import type { ResearchBar } from '../research/ohlcvTypes';
import { continuousIntelligence } from '../config/continuousIntelligence';
import type { MarketSession } from '../replay/marketSession';

export type RankingComponentName =
  | 'momentum' | 'relativeVolume' | 'rangeExpansion' | 'gap' | 'liquidity'
  | 'newsCatalyst' | 'agentConfidence' | 'javaQuantScore';

export interface ComponentResult {
  score: number | null; // 0-1, null iff !available
  available: boolean;
  reason?: string;
}

export type ComponentSet = Record<RankingComponentName, ComponentResult>;

/** Components in the target list this deployment cannot honestly compute yet - documented, not faked. */
export const NOT_IMPLEMENTED_COMPONENTS = [
  { name: 'sectorRelativeStrength', reason: 'Requires a sector-basket comparison feed; PositionSizing.ts\'s SECTOR_MAP exists but no sector-index performance series is fetched anywhere in this codebase yet.' },
  { name: 'marketRegimeCompatibility', reason: 'Regime classification exists per-symbol in quant_assessments for symbols QuantEngine has already evaluated, but there is no ranking-time regime lookup for the broad (non-subscribed) scan universe.' },
  { name: 'volatilitySuitability', reason: 'Requires historical OHLCV bars; SnapshotScanner only fetches a live snapshot (last trade/minute/daily bar), not a bar history, per symbol per cycle.' },
  { name: 'historicalSetupQuality', reason: 'Requires a backtested track record per setup type; no such backtest-to-live-setup mapping exists yet.' },
  { name: 'premarketActivitySeparateFromMinuteBar', reason: 'Alpaca IEX snapshot minuteBar is the latest available bar regardless of session - there is no separate premarket-only bar distinguishable from a regular-session minute bar in the feed this deployment uses.' },
] as const;

export interface RankingInput {
  symbol: string;
  last: number;
  prevClose: number;
  open: number | null;
  prevOpen: number | null;
  minuteHigh: number | null;
  minuteLow: number | null;
  minuteClose: number | null;
  dailyVolume: number | null;
  prevDayVolume: number | null;
  /** 0-1 raw values already computed by scoreSnapshotCandidate-equivalent math. */
  rawMomentumPct: number; // intradayPctChange
  rawRelativeVolume: number;
  rawRangeExpansion: number;
}

const RVOL_SCALE_CAP = 3; // relativeVolume >= this maps to score 1.0
const MOMENTUM_SCALE_CAP_PCT = 10; // |intradayPctChange| >= this% maps to score 1.0
const LIQUIDITY_SCALE_CAP_DOLLARS = 50_000_000; // dailyVolume * price >= this maps to score 1.0
const GAP_SCALE_CAP_PCT = 5;

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Real, deterministic components computable from the SAME snapshot data SnapshotScanner already fetches - no new network calls. */
export function computeDeterministicComponents(input: RankingInput): Pick<ComponentSet, 'momentum' | 'relativeVolume' | 'rangeExpansion' | 'gap' | 'liquidity'> {
  const momentum: ComponentResult = { score: clamp01(Math.abs(input.rawMomentumPct) / MOMENTUM_SCALE_CAP_PCT), available: true };
  const relativeVolume: ComponentResult = { score: clamp01(input.rawRelativeVolume / RVOL_SCALE_CAP), available: true };
  const rangeExpansion: ComponentResult = { score: clamp01(input.rawRangeExpansion), available: true };

  let gap: ComponentResult;
  if (input.open != null && input.prevClose > 0) {
    const gapPct = Math.abs((input.open - input.prevClose) / input.prevClose) * 100;
    gap = { score: clamp01(gapPct / GAP_SCALE_CAP_PCT), available: true };
  } else {
    gap = { score: null, available: false, reason: 'No open price on the fetched daily bar for this symbol this cycle.' };
  }

  let liquidity: ComponentResult;
  if (input.dailyVolume != null && input.dailyVolume > 0 && input.last > 0) {
    const dollarVolume = input.dailyVolume * input.last;
    liquidity = { score: clamp01(dollarVolume / LIQUIDITY_SCALE_CAP_DOLLARS), available: true };
  } else {
    liquidity = { score: null, available: false, reason: 'No daily volume on the fetched snapshot for this symbol this cycle.' };
  }

  return { momentum, relativeVolume, rangeExpansion, gap, liquidity };
}

/**
 * Batch lookup (ONE query for the whole scan universe, not one per symbol) of real recent news
 * catalyst impact per symbol from news_clusters. A symbol with no matching cluster in the lookback
 * window is marked unavailable (no catalyst evidence found), never scored 0-as-bearish.
 */
export interface NewsCatalystDetail {
  eventType: string | null;
  /** Real corroboration count (news_clusters.sourceCount) - distinct outlets that independently
   *  reported the same event. Named sourceCount, not "reliability": this is a raw corroboration
   *  count, not a calibrated trust score - see this file's own NOT_IMPLEMENTED_COMPONENTS
   *  discipline about not fabricating a stronger claim than the data supports. */
  sourceCount: number;
  impactScore: number;
}

/**
 * Structured catalyst detail for TradePlanBuilder's thesis object (Session-Aware Trading
 * Architecture Phase 4, 2026-09-05) - a SEPARATE query from fetchNewsCatalystScores above
 * (which stays unchanged, used only for ranking) so this addition carries zero risk to the
 * existing scoring path. Only the highest-impact cluster per symbol in the lookback window is
 * returned, matching fetchNewsCatalystScores' own "best cluster wins" convention.
 */
export async function fetchNewsCatalystDetails(symbols: string[], lookbackMs: number): Promise<Map<string, NewsCatalystDetail>> {
  const result = new Map<string, NewsCatalystDetail>();
  const since = new Date(Date.now() - lookbackMs).toISOString();
  try {
    const rows = await db.select({
      symbols: newsClusters.symbols, impactScore: newsClusters.impactScore,
      eventType: newsClusters.eventType, sourceCount: newsClusters.sourceCount,
    }).from(newsClusters).where(gte(newsClusters.createdAt, since));
    for (const row of rows) {
      if (!row.symbols || typeof row.impactScore !== 'number') continue;
      let parsed: string[] = [];
      try { parsed = JSON.parse(row.symbols); } catch { continue; }
      for (const sym of parsed) {
        const normalized = String(sym).toUpperCase();
        const existing = result.get(normalized);
        if (!existing || row.impactScore > existing.impactScore) {
          result.set(normalized, { eventType: row.eventType, sourceCount: row.sourceCount ?? 1, impactScore: row.impactScore });
        }
      }
    }
  } catch {
    /* best-effort - a missing lookup just means catalystType/catalystSourceCount stay null */
  }
  return result;
}

export async function fetchNewsCatalystScores(symbols: string[], lookbackMs: number): Promise<Map<string, ComponentResult>> {
  const result = new Map<string, ComponentResult>();
  const since = new Date(Date.now() - lookbackMs).toISOString();
  try {
    const rows = await db.select({ symbols: newsClusters.symbols, impactScore: newsClusters.impactScore })
      .from(newsClusters)
      .where(gte(newsClusters.createdAt, since));
    const bestBySymbol = new Map<string, number>();
    for (const row of rows) {
      if (!row.symbols || typeof row.impactScore !== 'number') continue;
      let parsed: string[] = [];
      try { parsed = JSON.parse(row.symbols); } catch { continue; }
      for (const sym of parsed) {
        const normalized = String(sym).toUpperCase();
        const existing = bestBySymbol.get(normalized) ?? 0;
        bestBySymbol.set(normalized, Math.max(existing, row.impactScore));
      }
    }
    for (const symbol of symbols) {
      const impact = bestBySymbol.get(symbol);
      result.set(symbol, impact != null
        ? { score: clamp01(impact), available: true }
        : { score: null, available: false, reason: `No news cluster mentioned this symbol in the last ${Math.round(lookbackMs / 60000)} minutes.` });
    }
  } catch (e) {
    for (const symbol of symbols) {
      result.set(symbol, { score: null, available: false, reason: 'news_clusters lookup failed' });
    }
  }
  return result;
}

/**
 * Batch lookup of the most recent agent prediction confidence per symbol (agent_predictions),
 * as a proxy for "how much recent, real agent attention has this symbol already received" -
 * distinct from and computed independently of the live consensus pipeline.
 */
export async function fetchAgentConfidenceScores(symbols: string[], lookbackMs: number): Promise<Map<string, ComponentResult>> {
  const result = new Map<string, ComponentResult>();
  if (symbols.length === 0) return result;
  const since = new Date(Date.now() - lookbackMs).toISOString();
  try {
    const rows = await db.select({ symbol: agentPredictions.symbol, confidence: agentPredictions.confidence, timestamp: agentPredictions.timestamp })
      .from(agentPredictions)
      .where(inArray(agentPredictions.symbol, symbols))
      .orderBy(desc(agentPredictions.timestamp));
    const latestBySymbol = new Map<string, number>();
    for (const row of rows) {
      if (row.timestamp < since) continue;
      if (!latestBySymbol.has(row.symbol)) latestBySymbol.set(row.symbol, row.confidence);
    }
    for (const symbol of symbols) {
      const conf = latestBySymbol.get(symbol);
      result.set(symbol, conf != null
        ? { score: clamp01(conf), available: true }
        : { score: null, available: false, reason: `No agent_predictions row for this symbol in the last ${Math.round(lookbackMs / 60000)} minutes.` });
    }
  } catch (e) {
    for (const symbol of symbols) {
      result.set(symbol, { score: null, available: false, reason: 'agent_predictions lookup failed' });
    }
  }
  return result;
}

/**
 * Session-Aware Trading Architecture Phase 3 (2026-09-05): the Java quant engine's one path into
 * ranking, per docs/architecture/ARGUS_PREMARKET_GAP_ANALYSIS.md §6 - the prior 7 components were
 * pure TypeScript arithmetic with zero Java involvement, contradicting this codebase's own
 * Java-authority policy for new quant/scoring work (CLAUDE.md "Java 26 Engine Authority").
 *
 * Deliberately NOT computed for the whole scan universe every cycle (unlike the other components
 * above): FactorAlphaEngine needs ~60+ daily bars per symbol (JavaQuantAdvisoryService's own
 * floor), so fetching bars + a Java HTTP call for every candidate in a broad discovery universe
 * would be exactly the "AI/quant as the market scanner" cost mistake this mission's brief warns
 * against (cheap deterministic filtering must happen BEFORE any per-symbol quant call, not
 * instead of it). Callers pass bars ONLY for symbols they've already decided are worth the cost
 * (e.g. a small PROMOTE-tier set) - `runRankingCycle()`'s default (no bars supplied) computes
 * zero Java calls, identical cost to before this component existed.
 */
export async function fetchJavaQuantScores(barsBySymbol: Map<string, ResearchBar[]>): Promise<Map<string, ComponentResult>> {
  const result = new Map<string, ComponentResult>();
  const entries = Array.from(barsBySymbol.entries());
  await Promise.all(entries.map(async ([symbol, bars]) => {
    try {
      const factors = await quantCoreBridge.fetchInstitutionalFactors(symbol, bars);
      if (factors === null) {
        result.set(symbol, { score: null, available: false, reason: 'Java quant core disabled, unreachable, or insufficient bar history for this symbol.' });
        return;
      }
      // Magnitude only (Math.abs), matching every other component's "how strong is this setup"
      // convention - direction is a separate concept these ranking components don't carry.
      const score = clamp01(Math.abs(factors.composite) / FACTOR_CONFIDENCE_SCALE);
      result.set(symbol, { score, available: true });
    } catch {
      result.set(symbol, { score: null, available: false, reason: 'Java quant factors lookup threw.' });
    }
  }));
  return result;
}

export interface RankingWeights {
  momentum: number;
  relativeVolume: number;
  rangeExpansion: number;
  gap: number;
  liquidity: number;
  newsCatalyst: number;
  agentConfidence: number;
  javaQuantScore: number;
}

export interface ScoredCandidate {
  symbol: string;
  components: ComponentSet;
  finalScore: number;
  weightsUsed: Partial<RankingWeights>;
}

/** Weighted sum over AVAILABLE components only - an unavailable component contributes neither to
 *  the numerator nor the denominator, so a symbol missing one component is compared fairly against
 *  one with full data, not penalized for a data gap it didn't cause. */
export function computeFinalScore(components: ComponentSet, weights: RankingWeights): { finalScore: number; weightsUsed: Partial<RankingWeights> } {
  let numerator = 0;
  let denominator = 0;
  const weightsUsed: Partial<RankingWeights> = {};
  for (const name of Object.keys(components) as RankingComponentName[]) {
    const c = components[name];
    if (!c.available || c.score === null) continue;
    const w = weights[name];
    numerator += c.score * w;
    denominator += w;
    weightsUsed[name] = w;
  }
  return { finalScore: denominator > 0 ? numerator / denominator : 0, weightsUsed };
}

export interface RankedCandidate extends ScoredCandidate {
  rank: number;
  previousRank: number | null;
  rankDelta: number | null;
  promotionRecommendation: 'PROMOTE' | 'HOLD' | 'REJECT';
  promotionReason: string;
}

/** Sorts by finalScore desc and assigns rank + a simple threshold-based promotion recommendation.
 *  The actual promote/demote STATE MACHINE (hysteresis, cooldown, capacity) is Phase 4D's job -
 *  this only recommends, it never mutates a live subscription. */
export function rankCandidates(
  scored: ScoredCandidate[],
  previousRanks: Map<string, number>,
  promoteThreshold: number,
  rejectThreshold: number,
): RankedCandidate[] {
  const sorted = [...scored].sort((a, b) => b.finalScore - a.finalScore);
  return sorted.map((c, i) => {
    const rank = i + 1;
    const previousRank = previousRanks.get(c.symbol) ?? null;
    const rankDelta = previousRank !== null ? previousRank - rank : null;
    let promotionRecommendation: RankedCandidate['promotionRecommendation'];
    let promotionReason: string;
    if (c.finalScore >= promoteThreshold) {
      promotionRecommendation = 'PROMOTE';
      promotionReason = `Final score ${c.finalScore.toFixed(3)} >= promote threshold ${promoteThreshold}.`;
    } else if (c.finalScore <= rejectThreshold) {
      promotionRecommendation = 'REJECT';
      promotionReason = `Final score ${c.finalScore.toFixed(3)} <= reject threshold ${rejectThreshold}.`;
    } else {
      promotionRecommendation = 'HOLD';
      promotionReason = `Final score ${c.finalScore.toFixed(3)} between reject (${rejectThreshold}) and promote (${promoteThreshold}) thresholds.`;
    }
    return { ...c, rank, previousRank, rankDelta, promotionRecommendation, promotionReason };
  });
}

/** Most recent PRIOR cycle's rank per symbol (before `beforeIso`), for rank-delta computation. One
 *  query for the whole batch via a per-symbol correlated MAX(cycle_at), not one query per symbol. */
export async function fetchPreviousRanks(symbols: string[], beforeIso: string): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (symbols.length === 0) return result;
  try {
    const rows = await db.select({ symbol: candidateRankings.symbol, rank: candidateRankings.rank, cycleAt: candidateRankings.cycleAt })
      .from(candidateRankings)
      .where(inArray(candidateRankings.symbol, symbols))
      .orderBy(desc(candidateRankings.cycleAt));
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.cycleAt >= beforeIso) continue; // only strictly prior cycles
      if (seen.has(row.symbol)) continue;
      seen.add(row.symbol);
      result.set(row.symbol, row.rank);
    }
  } catch {
    /* best-effort - a missing previous-rank history just means rankDelta reports null this cycle */
  }
  return result;
}

export async function persistRankingCycle(ranked: RankedCandidate[], cycleAt: string): Promise<void> {
  if (ranked.length === 0) return;
  try {
    await db.insert(candidateRankings).values(ranked.map((r) => ({
      symbol: r.symbol,
      cycleAt,
      momentumScore: r.components.momentum.score,
      relativeVolumeScore: r.components.relativeVolume.score,
      rangeExpansionScore: r.components.rangeExpansion.score,
      gapScore: r.components.gap.score,
      liquidityScore: r.components.liquidity.score,
      newsCatalystScore: r.components.newsCatalyst.score,
      agentConfidenceScore: r.components.agentConfidence.score,
      javaQuantScore: r.components.javaQuantScore.score,
      componentAvailability: JSON.stringify(
        Object.fromEntries((Object.keys(r.components) as RankingComponentName[]).map((name) => [
          name, { available: r.components[name].available, reason: r.components[name].reason },
        ])),
      ),
      weightsUsed: JSON.stringify(r.weightsUsed),
      finalScore: r.finalScore,
      rank: r.rank,
      previousRank: r.previousRank,
      rankDelta: r.rankDelta,
      promotionRecommendation: r.promotionRecommendation,
      promotionReason: r.promotionReason,
      createdAt: cycleAt,
    })));
  } catch (e) {
    console.error('[ComposableRanking] Failed to persist ranking cycle', e);
  }
}

const DEFAULT_WEIGHTS: RankingWeights = {
  momentum: 1, relativeVolume: 1, rangeExpansion: 0.5, gap: 0.5, liquidity: 0.5,
  newsCatalyst: 1, agentConfidence: 0.5, javaQuantScore: 1,
};
const NEWS_LOOKBACK_MS = 4 * 60 * 60 * 1000; // matches gate 14 news_veto's own newsVetoWindowMs order of magnitude
const AGENT_CONFIDENCE_LOOKBACK_MS = 60 * 60 * 1000;
/** Fallback only for a CLOSED-session caller (ranking cycles are not expected to run then) - see
 *  config/continuousIntelligence.json's rankingThresholdsBySession comment for the session-aware path. */
const FALLBACK_THRESHOLDS = { promote: 0.65, reject: 0.25 };

/**
 * Orchestrates one full ranking cycle: batch news/agent-confidence lookups, deterministic
 * component computation, previous-rank lookup, final scoring, and persistence. Called by
 * SnapshotScanner.refreshSnapshotRanks() with the SAME snapshot data it already fetched - no new
 * network calls are added by this function for any symbol NOT present in `javaQuantBarsBySymbol`
 * (default: empty map, i.e. zero Java calls, identical cost to before that parameter existed).
 *
 * `session` (Session-Aware Trading Architecture Phase 2 follow-up, 2026-09-05) selects the
 * promote/reject bar from continuousIntelligence.rankingThresholdsBySession - defaults to
 * 'REGULAR' for any caller not yet passing a real session (identical behavior to before this
 * parameter existed, since REGULAR's configured values equal the previous hardcoded constants).
 */
export async function runRankingCycle(
  inputs: RankingInput[],
  now: Date = new Date(),
  javaQuantBarsBySymbol: Map<string, ResearchBar[]> = new Map(),
  session: MarketSession = 'REGULAR',
): Promise<RankedCandidate[]> {
  if (inputs.length === 0) return [];
  const thresholds = session === 'CLOSED'
    ? FALLBACK_THRESHOLDS
    : continuousIntelligence.rankingThresholdsBySession[session];
  const symbols = inputs.map((i) => i.symbol);
  const cycleAt = now.toISOString();

  const [newsScores, agentScores, previousRanks, javaQuantScores] = await Promise.all([
    fetchNewsCatalystScores(symbols, NEWS_LOOKBACK_MS),
    fetchAgentConfidenceScores(symbols, AGENT_CONFIDENCE_LOOKBACK_MS),
    fetchPreviousRanks(symbols, cycleAt),
    fetchJavaQuantScores(javaQuantBarsBySymbol),
  ]);

  const scored: ScoredCandidate[] = inputs.map((input) => {
    const deterministic = computeDeterministicComponents(input);
    const components: ComponentSet = {
      ...deterministic,
      newsCatalyst: newsScores.get(input.symbol) ?? { score: null, available: false, reason: 'not looked up' },
      agentConfidence: agentScores.get(input.symbol) ?? { score: null, available: false, reason: 'not looked up' },
      javaQuantScore: javaQuantScores.get(input.symbol) ?? { score: null, available: false, reason: 'Java quant score not requested for this symbol this cycle (cost-bounded - only computed for a caller-selected subset).' },
    };
    const { finalScore, weightsUsed } = computeFinalScore(components, DEFAULT_WEIGHTS);
    return { symbol: input.symbol, components, finalScore, weightsUsed };
  });

  const ranked = rankCandidates(scored, previousRanks, thresholds.promote, thresholds.reject);
  await persistRankingCycle(ranked, cycleAt);
  return ranked;
}
