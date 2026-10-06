/**
 * Post-market reflection outcome audits (workstream I, 2026-10-06, local-only).
 *
 * DIAGNOSTIC ONLY. This module never emits trade ideas, never calls ChiefTrader,
 * RiskEngine, OMS, or BrokerManager, never changes consensus (0.75), independence
 * requirements, RiskEngine gates, freshness requirements, or capital limits, and
 * never enables any strategy. A filter or risk rejection that later "would have
 * worked" is recorded as a research observation only - it is NEVER a reason to
 * loosen the gate that fired. That prohibition is structural: the premise-correctness
 * judgment below takes only (reason, contemporaneous evidence, thresholds) and has
 * no parameter for outcome data at all, so a later rally cannot flip it.
 *
 * What it does, per trading date:
 *  1. Causal outcome windows: for a symbol + decision timestamp, forward moves over
 *     +5m/+15m/+30m/+60m/close computed from recorded 1-min bars in `ohlcvBars`,
 *     EXCLUDING the bar containing the decision timestamp (no same-bar hindsight).
 *     Persisted as JSON into mover_coverage.outcome_windows (workstream H's table).
 *     Bars unavailable -> null windows, never fabricated.
 *  2. Discovery-filtered outcome audit: for mover_coverage rows with
 *     primary_fate='DISCOVERED_FILTERED', loads the stored contemporaneous filter
 *     reason + evidence from the discovery lineage ledger (observability_events),
 *     judges premise correctness AT DECISION TIME into filter_premise_correct
 *     (0/1/null), and records the evidence snapshot in secondary_reasons.
 *  3. Risk-rejected outcome audit: for primary_fate='RISK_REJECTED', records the
 *     rejecting gate(s), decision timestamp, and reference price (price at
 *     decision), plus outcome windows per (1).
 *  4. Pre-market effectiveness: per major mover, known-by evidence across
 *     plan0400 (trade_plans v1 for the date), refresh0915 (premarket_focus_reports
 *     or later plan revisions), fastLane (Fast Lane candidate/evaluation events),
 *     discovery (lineage ledger) -> mover_coverage.premarket_known_by JSON.
 *     This measures the incremental value of the late (~09:15) refresh.
 *  5. Data readiness at open: for PRIMARY-tier focus-report entries, classifies
 *     each as fresh / subscribed / failing-with-why (no subscription slot, stale
 *     quote, reservation denied, rescue denied...), joining
 *     premarket_data_reservations. Target is diagnosis, not a blind 100%.
 *  6. Session metrics: computes and persists reflection_session_metrics per date.
 *
 * Entry point: `callOutcomeAudits(tradingDate)` - the hook the daily reflection
 * (dailyReflection.ts) calls. Idempotent per date (upserts).
 *
 * Java Engine Authority note (repo AGENTS.md): the only arithmetic here is
 * diagnostic return computation on recorded bars - the same category as
 * PostMarketAnalysis.auditRejectedCandidates' existing
 * ((close - priceAtDetection) / priceAtDetection) * 100. No indicator, strategy,
 * signal, or portfolio-optimization math is introduced; nothing here influences a
 * trading decision, so this stays TypeScript with the quant-core-java rule intact.
 */
import { sqliteDb } from '../db';
import { continuousIntelligence } from '../config/continuousIntelligence';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One recorded bar (1-min from ohlcvBars in production; crafted in tests). */
export interface OutcomeBarInput {
  timestamp: number; // bar open time, epoch ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OutcomeWindowResult {
  /** Forward return (%) from the reference price to this window's last bar close. */
  movePct: number | null;
  barsUsed: number;
  endIso: string | null;
}

export interface OutcomeWindows {
  /** Anchor for all moves: the close of the bar containing the decision timestamp
   *  (or a stored price-at-decision when one exists). The decision bar itself is
   *  never counted as an outcome bar. */
  referencePrice: number | null;
  referenceSource: 'DECISION_BAR_CLOSE' | 'STORED_PRICE_AT_DECISION' | null;
  decisionBarIso: string | null;
  w5m: OutcomeWindowResult;
  w15m: OutcomeWindowResult;
  w30m: OutcomeWindowResult;
  w60m: OutcomeWindowResult;
  close: OutcomeWindowResult;
  /** Set when windows could not be computed honestly (bars missing etc.). */
  unavailableReason: string | null;
}

/** Injectable bar source: (symbol, startMs, endMs) -> bars. Production reads the
 *  recorded `ohlcvBars` table; tests inject crafted bars. Never fabricates. */
export type BarProvider = (symbol: string, startMs: number, endMs: number) => Promise<OutcomeBarInput[]>;

/** Thresholds the filter premise is judged against - always from config in
 *  production (repo rule: no hardcoded operational thresholds in TS), injected
 *  explicitly in tests. */
export interface FilterThresholds {
  maxSpreadBps: number;
  minDollarVolume: number;
  minPrice: number;
  maxPrice: number;
  minAvgDailyVolumeShares: number;
  /** Rank cap for RANK_CAP/TOP_N judgments; null when the deployment does not
   *  expose a single comparable rank cap for the recorded reason. */
  rankCap: number | null;
}

export interface FilterJudgment {
  /** 1 = the filter's premise held at decision time (e.g. spread genuinely wide);
   *  0 = the premise did not hold; null = no contemporaneous evidence to judge. */
  premiseCorrect: 0 | 1 | null;
  basis: string;
}

export interface PremarketKnownBy {
  plan0400: boolean;
  plan0400At: string | null;
  refresh0915: boolean;
  refresh0915At: string | null;
  fastLane: boolean;
  fastLaneAt: string | null;
  discovery: boolean;
  discoveryAt: string | null;
  /** Ordered list of sources that knew the symbol pre-market. */
  sources: string[];
}

export type DataReadinessClass =
  | 'FRESH'
  | 'SUBSCRIBED_FRESH_UNKNOWN'
  | 'NO_SUBSCRIPTION_SLOT'
  | 'RESERVATION_DENIED'
  | 'RESERVED_BUT_STALE'
  | 'STALE_QUOTE'
  | 'RESCUE_DENIED'
  | 'PLAN_NOT_LIVE'
  | 'UNKNOWN';

export interface DataReadinessEntry {
  symbol: string;
  tier: string;
  readinessClass: DataReadinessClass;
  why: string;
  subscriptionState: string | null;
  dataFresh: boolean | null;
  reservationStatus: string | null;
}

export interface SessionMetrics {
  tradingDate: string;
  moversTotal: number | null;
  moversSeen: number | null;
  focusRecall: number | null;
  primaryDataReadiness: number | null;
  catalystCoverage: number | null;
  neverSeenRate: number | null;
  discoveryFilterRate: number | null;
  evaluationRate: number | null;
  validTriggerRate: number | null;
  consensusApprovalRate: number | null;
  primaryPrecision: number | null;
  /** Diagnostic detail (readiness breakdown, fate counts, known-by counts). */
  detailJson: string;
}

export interface OutcomeAuditSummary {
  tradingDate: string;
  moverCoverageAvailable: boolean;
  filteredAudited: number;
  riskRejectedAudited: number;
  knownByRecorded: number;
  dataReadiness: { entries: number; fresh: number; failing: number };
  metricsPersisted: boolean;
  notes: string[];
}

// ---------------------------------------------------------------------------
// 1. Causal outcome windows
// ---------------------------------------------------------------------------

const MIN_MS = 60_000;
const WINDOW_HORIZONS_MIN = [5, 15, 30, 60] as const;

function nullWindow(): OutcomeWindowResult {
  return { movePct: null, barsUsed: 0, endIso: null };
}

function nullWindows(unavailableReason: string): OutcomeWindows {
  return {
    referencePrice: null,
    referenceSource: null,
    decisionBarIso: null,
    w5m: nullWindow(),
    w15m: nullWindow(),
    w30m: nullWindow(),
    w60m: nullWindow(),
    close: nullWindow(),
    unavailableReason,
  };
}

/**
 * Compute forward outcome windows from a decision timestamp.
 *
 * Causal structure (the whole point of this function):
 * - The bar CONTAINING the decision timestamp is excluded from every window -
 *   same-bar hindsight is never counted as an outcome.
 * - The reference price is the close of that decision bar (or a stored
 *   price-at-decision when the caller has one), and every window measures only
 *   strictly-later bars.
 * - Bars unavailable -> null windows with unavailableReason set, never invented.
 *
 * @param symbol symbol to audit
 * @param decisionTsIso ISO timestamp of the real decision (filter/rejection time)
 * @param tradingDate YYYY-MM-DD (bounds the bar fetch to the session)
 * @param fetchBars recorded-bar source (production: ohlcvBars 1Min)
 * @param priceAtDecision optional stored price at decision (takes precedence as reference)
 */
export async function computeOutcomeWindows(
  symbol: string,
  decisionTsIso: string,
  tradingDate: string,
  fetchBars: BarProvider,
  priceAtDecision?: number | null,
): Promise<OutcomeWindows> {
  const decisionMs = Date.parse(decisionTsIso);
  if (!Number.isFinite(decisionMs)) return nullWindows('INVALID_DECISION_TIMESTAMP');
  const dayStartMs = Date.parse(`${tradingDate}T00:00:00.000Z`);
  const dayEndMs = Date.parse(`${tradingDate}T23:59:59.999Z`);
  if (!Number.isFinite(dayStartMs) || !Number.isFinite(dayEndMs)) return nullWindows('INVALID_TRADING_DATE');

  const decisionBarOpenMs = Math.floor(decisionMs / MIN_MS) * MIN_MS;
  const decisionBarIso = new Date(decisionBarOpenMs).toISOString();

  let bars: OutcomeBarInput[];
  try {
    bars = await fetchBars(symbol, decisionBarOpenMs, dayEndMs);
  } catch {
    return nullWindows('BAR_FETCH_FAILED');
  }
  const valid = (Array.isArray(bars) ? bars : [])
    .filter((b) => Number.isFinite(b?.timestamp) && Number.isFinite(b?.close))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (valid.length === 0) return nullWindows('NO_RECORDED_BARS');

  const decisionBar = valid.find((b) => b.timestamp === decisionBarOpenMs) ?? null;
  const storedRef = priceAtDecision != null && Number.isFinite(priceAtDecision) ? priceAtDecision : null;
  const referencePrice = storedRef ?? (decisionBar ? decisionBar.close : null);
  const referenceSource = storedRef != null ? 'STORED_PRICE_AT_DECISION' : decisionBar ? 'DECISION_BAR_CLOSE' : null;
  if (referencePrice == null || referencePrice <= 0) {
    return { ...nullWindows('NO_REFERENCE_PRICE'), decisionBarIso };
  }

  // Strictly-later bars only: the decision bar is never an outcome bar.
  const later = valid.filter((b) => b.timestamp > decisionBarOpenMs);
  if (later.length === 0) return { ...nullWindows('NO_POST_DECISION_BARS'), referencePrice, referenceSource, decisionBarIso };

  const windowFor = (horizonMin: number): OutcomeWindowResult => {
    const cutoffMs = decisionMs + horizonMin * MIN_MS;
    const eligible = later.filter((b) => b.timestamp < cutoffMs);
    if (eligible.length === 0) return nullWindow();
    const last = eligible[eligible.length - 1];
    return {
      movePct: ((last.close - referencePrice) / referencePrice) * 100,
      barsUsed: eligible.length,
      endIso: new Date(last.timestamp).toISOString(),
    };
  };

  const lastBar = later[later.length - 1];
  return {
    referencePrice,
    referenceSource,
    decisionBarIso,
    w5m: windowFor(WINDOW_HORIZONS_MIN[0]),
    w15m: windowFor(WINDOW_HORIZONS_MIN[1]),
    w30m: windowFor(WINDOW_HORIZONS_MIN[2]),
    w60m: windowFor(WINDOW_HORIZONS_MIN[3]),
    close: {
      movePct: ((lastBar.close - referencePrice) / referencePrice) * 100,
      barsUsed: later.length,
      endIso: new Date(lastBar.timestamp).toISOString(),
    },
    unavailableReason: null,
  };
}

/** Production bar provider: recorded 1-min bars from `ohlcvBars` (never live-fetched). */
export async function recordedBarProvider(symbol: string, startMs: number, endMs: number): Promise<OutcomeBarInput[]> {
  const rows = sqliteDb.prepare(
    `SELECT timestamp, open, high, low, close, volume FROM ohlcv_bars
     WHERE symbol = ? AND timeframe = '1Min' AND timestamp >= ? AND timestamp <= ?
     ORDER BY timestamp ASC`
  ).all(symbol.toUpperCase(), startMs, endMs) as Array<{
    timestamp: number; open: number; high: number; low: number; close: number; volume: number;
  }>;
  return rows.map((r) => ({ timestamp: r.timestamp, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
}

// ---------------------------------------------------------------------------
// 2. Discovery-filter premise judgment (at decision time ONLY)
// ---------------------------------------------------------------------------

/** Production thresholds from config (repo rule: no hardcoded operational thresholds). */
export function defaultFilterThresholds(): FilterThresholds {
  return {
    maxSpreadBps: continuousIntelligence.broadUniverseMaxSpreadBps,
    minDollarVolume: continuousIntelligence.broadUniverseMinDollarVolume,
    minPrice: continuousIntelligence.broadUniverseMinPrice,
    maxPrice: continuousIntelligence.broadUniverseMaxPrice,
    minAvgDailyVolumeShares: continuousIntelligence.broadUniverseMinAvgDailyVolumeShares,
    // The lineage payload does not record the rank the RANK_CAP fired on, so this
    // stays null in production: a RANK_CAP premise cannot be judged without the
    // contemporaneous rank, and we record null rather than guess.
    rankCap: null,
  };
}

export interface FilterEvidence {
  reason?: string | null;
  price?: number | null;
  dollarVolume?: number | null;
  spreadBps?: number | null;
  advShares?: number | null;
  rankAtCreation?: number | null;
  rank?: number | null;
  score?: number | null;
  quoteAgeMs?: number | null;
  staleQuote?: boolean | null;
  [key: string]: unknown;
}

/**
 * Judge whether a discovery filter's premise held AT DECISION TIME.
 *
 * Structural guarantee: this function receives only (reason, contemporaneous
 * evidence, thresholds). There is no outcome parameter - a later rally can
 * never flip the verdict. A SPREAD filter with genuinely wide spread at 09:31
 * is premise-correct (1) even if the stock rallied 20% afterwards; the rally
 * says the filter was expensive, not that its premise was wrong.
 */
export function judgeFilterPremise(
  reason: string | null | undefined,
  evidence: FilterEvidence | null | undefined,
  t: FilterThresholds,
): FilterJudgment {
  const r = (reason ?? '').trim().toUpperCase();
  const ev = evidence ?? {};
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  if (!r) return { premiseCorrect: null, basis: 'No filter reason recorded - cannot judge a premise that was never stated.' };
  const basis = (s: string) => s;

  switch (r) {
    case 'SPREAD': {
      const s = num(ev.spreadBps);
      if (s == null) return { premiseCorrect: null, basis: basis('SPREAD filter but no spreadBps in the contemporaneous evidence - unjudgeable.') };
      const ok = s > t.maxSpreadBps;
      return {
        premiseCorrect: ok ? 1 : 0,
        basis: basis(`At decision time spread was ${s.toFixed(1)} bps vs the ${t.maxSpreadBps} bps ceiling - premise ${ok ? 'held (spread genuinely wide)' : 'did NOT hold (spread within ceiling)'}.`),
      };
    }
    case 'SPREAD_CROSSED': {
      const s = num(ev.spreadBps);
      if (s == null) return { premiseCorrect: null, basis: basis('SPREAD_CROSSED filter but no spreadBps in the contemporaneous evidence - unjudgeable.') };
      const ok = s < 0;
      return {
        premiseCorrect: ok ? 1 : 0,
        basis: basis(`At decision time spreadBps was ${s.toFixed(1)} (${ok ? 'negative - quote genuinely crossed' : 'non-negative - quote not crossed'}).`),
      };
    }
    case 'PRICE': {
      const p = num(ev.price);
      if (p == null) return { premiseCorrect: null, basis: basis('PRICE filter but no price in the contemporaneous evidence - unjudgeable.') };
      const ok = p < t.minPrice || p > t.maxPrice;
      return {
        premiseCorrect: ok ? 1 : 0,
        basis: basis(`At decision time price was ${p} vs the [${t.minPrice}, ${t.maxPrice}] band - premise ${ok ? 'held (outside band)' : 'did NOT hold (inside band)'}.`),
      };
    }
    case 'DOLLAR_VOLUME':
    case 'LIQUIDITY': {
      const dv = num(ev.dollarVolume);
      if (dv == null) return { premiseCorrect: null, basis: basis(`${r} filter but no dollarVolume in the contemporaneous evidence - unjudgeable.`) };
      const ok = dv < t.minDollarVolume;
      return {
        premiseCorrect: ok ? 1 : 0,
        basis: basis(`At decision time dollar volume was ${dv.toFixed(0)} vs the ${t.minDollarVolume} floor - premise ${ok ? 'held (below floor)' : 'did NOT hold (above floor)'}.`),
      };
    }
    case 'ADV_BELOW_FLOOR':
    case 'ADV': {
      const adv = num(ev.advShares);
      if (adv == null) return { premiseCorrect: null, basis: basis(`${r} filter but no advShares in the contemporaneous evidence - unjudgeable (and distinct from ADV_DATA_UNAVAILABLE, which asserts there was nothing to measure).`) };
      const ok = adv < t.minAvgDailyVolumeShares;
      return {
        premiseCorrect: ok ? 1 : 0,
        basis: basis(`At decision time measured ADV was ${adv.toFixed(0)} shares vs the ${t.minAvgDailyVolumeShares} floor - premise ${ok ? 'held (below floor)' : 'did NOT hold (above floor)'}.`),
      };
    }
    case 'ADV_DATA_UNAVAILABLE': {
      const adv = num(ev.advShares);
      const ok = adv == null;
      return {
        premiseCorrect: ok ? 1 : 0,
        basis: basis(ok
          ? 'No ADV value was obtainable at decision time (advShares null) - the filter correctly failed closed on missing data.'
          : `A real ADV value (${(adv as number).toFixed(0)} shares) was present at decision time - the "data unavailable" premise did not hold.`),
      };
    }
    case 'NO_SNAPSHOT_DATA':
    case 'NO_SCORE':
    case 'NO_SCORE_EVIDENCE': {
      const hasSnapshot = num(ev.price) != null || num(ev.spreadBps) != null || num(ev.dollarVolume) != null;
      const hasScore = num(ev.score) != null;
      const ok = !hasSnapshot && !hasScore;
      return {
        premiseCorrect: ok ? 1 : 0,
        basis: basis(ok
          ? 'No snapshot fields and no score were present in the contemporaneous evidence - the "nothing to evaluate" premise held.'
          : 'Snapshot fields or a score WERE present in the contemporaneous evidence - the "nothing to evaluate" premise did not hold.'),
      };
    }
    case 'RANK_CAP':
    case 'TOP_N': {
      const rank = num(ev.rankAtCreation) ?? num(ev.rank);
      if (rank == null || t.rankCap == null) {
        return { premiseCorrect: null, basis: basis('RANK_CAP/TOP_N filter but the contemporaneous rank (or a comparable rank cap) was not recorded - unjudgeable, never guessed.') };
      }
      const ok = rank > t.rankCap;
      return {
        premiseCorrect: ok ? 1 : 0,
        basis: basis(`At decision time rank was ${rank} vs the ${t.rankCap} cap - premise ${ok ? 'held (beyond cap)' : 'did NOT hold (within cap)'}.`),
      };
    }
    case 'STALE_DATA': {
      const staleFlag = ev.staleQuote === true;
      const age = num(ev.quoteAgeMs);
      if (staleFlag) return { premiseCorrect: 1, basis: basis('The contemporaneous evidence carries an explicit stale-quote flag - the staleness premise held.') };
      if (age != null) {
        return { premiseCorrect: 0, basis: basis(`The contemporaneous evidence records a quote age of ${age}ms with no stale flag - the staleness premise did not hold on the recorded evidence.`) };
      }
      return { premiseCorrect: null, basis: basis('STALE_DATA filter but no staleness indicator in the contemporaneous evidence - unjudgeable.') };
    }
    default:
      return { premiseCorrect: null, basis: basis(`Unrecognized filter reason '${r}' - no judgment rule exists; recorded as unjudgeable rather than guessed.`) };
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function tableExists(name: string): boolean {
  try {
    const row = sqliteDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name) as { name?: string } | undefined;
    return !!row?.name;
  } catch {
    return false;
  }
}

/** Workstream H's table. Absent until 0093 lands - every audit below degrades
 *  gracefully to "nothing to audit" rather than throwing. */
function moverCoverageAvailable(): boolean {
  return tableExists('mover_coverage');
}

interface MoverCoverageRow {
  trading_date: string;
  symbol: string;
  eod_move_pct: number | null;
  primary_fate: string | null;
  secondary_reasons: string | null;
  never_seen_cause: string | null;
  reference_price: number | null;
  outcome_windows: string | null;
  filter_reason: string | null;
  filter_premise_correct: number | null;
  premarket_known_by: string | null;
}

function readMoverRows(tradingDate: string, fates?: string[]): MoverCoverageRow[] {
  if (!moverCoverageAvailable()) return [];
  const where = fates && fates.length > 0
    ? `WHERE trading_date = ? AND primary_fate IN (${fates.map(() => '?').join(',')})`
    : `WHERE trading_date = ?`;
  return sqliteDb.prepare(`SELECT * FROM mover_coverage ${where} ORDER BY symbol ASC`).all(tradingDate, ...(fates ?? [])) as MoverCoverageRow[];
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * mover_coverage.secondary_reasons is a JSON array of strings (workstream H's
 * writer contract; workstream J's report reader filters to strings). Audit
 * blocks are appended as JSON-encoded STRING elements carrying a `kind`
 * discriminator - the full structured evidence stays parseable via one
 * JSON.parse, while the column keeps its string[] shape for every reader.
 */
function parseJsonStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function appendAuditNote(raw: string | null, kind: string, block: Record<string, unknown>): string {
  return JSON.stringify([...parseJsonStringArray(raw), JSON.stringify({ kind, ...block })]);
}

/**
 * Merge causal outcome windows into any existing outcome_windows JSON without
 * destroying it. Workstream H persists an `{eod: {...}}` summary block there;
 * the causal intraday windows merge flat alongside it (keys w5m/w15m/w30m/w60m/
 * close/referencePrice/... - no collision with H's `eod` key). A null/empty
 * existing value just becomes this workstream's windows object.
 */
export function mergeOutcomeWindows(existingRaw: string | null, windows: OutcomeWindows): string {
  const existing = parseJsonObject(existingRaw);
  return JSON.stringify({ ...existing, ...windows });
}

/** Extract this workstream's audit block (by kind) from a secondary_reasons array. */
export function readAuditNote(raw: string | null, kind: string): Record<string, unknown> | null {
  for (const el of parseJsonStringArray(raw)) {
    try {
      const v = JSON.parse(el) as Record<string, unknown>;
      if (v && typeof v === 'object' && v.kind === kind) return v;
    } catch { /* not an audit note - skip */ }
  }
  return null;
}

function updateMoverRow(tradingDate: string, symbol: string, patch: Partial<Pick<MoverCoverageRow, 'secondary_reasons' | 'reference_price' | 'outcome_windows' | 'filter_premise_correct' | 'premarket_known_by'>>): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.secondary_reasons !== undefined) { sets.push('secondary_reasons = ?'); vals.push(patch.secondary_reasons); }
  if (patch.reference_price !== undefined) { sets.push('reference_price = ?'); vals.push(patch.reference_price); }
  if (patch.outcome_windows !== undefined) { sets.push('outcome_windows = ?'); vals.push(patch.outcome_windows); }
  if (patch.filter_premise_correct !== undefined) { sets.push('filter_premise_correct = ?'); vals.push(patch.filter_premise_correct); }
  if (patch.premarket_known_by !== undefined) { sets.push('premarket_known_by = ?'); vals.push(patch.premarket_known_by); }
  if (sets.length === 0) return;
  sqliteDb.prepare(`UPDATE mover_coverage SET ${sets.join(', ')} WHERE trading_date = ? AND symbol = ?`).run(...vals, tradingDate, symbol);
}

/** Earliest DISCOVERY_CANDIDATE_FILTERED lineage event for a symbol on a date,
 *  with the payload normalized (handles both flat and {payload:{...}} shapes,
 *  mirroring PostMarketAnalysis.buildFindings). */
function readLineageFilterEvent(symbol: string, dayStartMs: number, dayEndMs: number): { tsMs: number; reason: string | null; evidence: FilterEvidence } | null {
  try {
    const row = sqliteDb.prepare(
      `SELECT ts, payload FROM observability_events
       WHERE symbol = ? AND event_type = 'DISCOVERY_CANDIDATE_FILTERED' AND ts >= ? AND ts < ?
       ORDER BY ts ASC LIMIT 1`
    ).get(symbol.toUpperCase(), dayStartMs, dayEndMs) as { ts: number; payload: string | null } | undefined;
    if (!row) return null;
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(row.payload ?? '{}') as Record<string, unknown>; } catch { /* malformed - evidence stays empty */ }
    const inner = (parsed.reason ? parsed : (parsed.payload as Record<string, unknown> | undefined)) ?? {};
    const rec = (inner && typeof inner === 'object' ? inner : {}) as Record<string, unknown>;
    const evidence: FilterEvidence = {
      reason: typeof rec.reason === 'string' ? rec.reason : null,
      price: typeof rec.price === 'number' ? rec.price : null,
      dollarVolume: typeof rec.dollarVolume === 'number' ? rec.dollarVolume : null,
      spreadBps: typeof rec.spreadBps === 'number' ? rec.spreadBps : null,
      advShares: typeof rec.advShares === 'number' ? rec.advShares : null,
    };
    return { tsMs: row.ts, reason: evidence.reason, evidence };
  } catch {
    return null;
  }
}

function dayBoundsMs(tradingDate: string): { start: number; end: number; startIso: string } {
  const start = Date.parse(`${tradingDate}T00:00:00.000Z`);
  const end = Date.parse(`${tradingDate}T23:59:59.999Z`);
  return { start, end, startIso: `${tradingDate}T00:00:00.000Z` };
}

// ---------------------------------------------------------------------------
// 3. Discovery-filtered outcome audit
// ---------------------------------------------------------------------------

export interface FilterAuditDeps {
  fetchBars?: BarProvider;
  thresholds?: FilterThresholds;
}

/**
 * For every DISCOVERED_FILTERED mover: load the contemporaneous lineage filter
 * event, judge the premise at decision time (never from the later outcome),
 * compute causal outcome windows from the filter timestamp, and persist.
 */
export async function auditDiscoveryFiltered(tradingDate: string, deps: FilterAuditDeps = {}): Promise<{ audited: number; notes: string[] }> {
  const notes: string[] = [];
  const rows = readMoverRows(tradingDate, ['DISCOVERED_FILTERED']);
  if (!moverCoverageAvailable()) {
    notes.push('mover_coverage table absent (workstream H 0093 not yet applied) - discovery-filter audit skipped.');
    return { audited: 0, notes };
  }
  const { start, end } = dayBoundsMs(tradingDate);
  const fetchBars = deps.fetchBars ?? recordedBarProvider;
  const thresholds = deps.thresholds ?? defaultFilterThresholds();
  let audited = 0;

  for (const row of rows) {
    const sym = row.symbol.toUpperCase();
    const lineage = readLineageFilterEvent(sym, start, end);
    const reason = lineage?.reason ?? row.filter_reason ?? null;
    const evidence = lineage?.evidence ?? {};
    const judgment = judgeFilterPremise(reason, evidence, thresholds);

    let windows: OutcomeWindows | null = null;
    if (lineage) {
      windows = await computeOutcomeWindows(sym, new Date(lineage.tsMs).toISOString(), tradingDate, fetchBars, evidence.price ?? null);
    }

    const auditBlock = {
      filterReason: reason,
      filterDecisionAtIso: lineage ? new Date(lineage.tsMs).toISOString() : null,
      // The full contemporaneous evidence snapshot - what the filter saw, frozen.
      evidenceSnapshot: evidence,
      premiseJudgment: {
        premiseCorrect: judgment.premiseCorrect,
        basis: judgment.basis,
        judgedAtIso: new Date().toISOString(),
        thresholdsUsed: {
          maxSpreadBps: thresholds.maxSpreadBps,
          minDollarVolume: thresholds.minDollarVolume,
          priceBand: [thresholds.minPrice, thresholds.maxPrice],
          minAvgDailyVolumeShares: thresholds.minAvgDailyVolumeShares,
        },
      },
      // Outcome windows are recorded for research context only. A favorable later
      // move does NOT flip premiseCorrect above - the judgment is sealed at
      // decision time by construction.
      outcomeWindows: windows,
      eodMovePct: row.eod_move_pct,
    };
    updateMoverRow(tradingDate, row.symbol, {
      secondary_reasons: appendAuditNote(row.secondary_reasons, 'discoveryFilterAudit', auditBlock),
      outcome_windows: windows ? mergeOutcomeWindows(row.outcome_windows, windows) : row.outcome_windows,
      filter_premise_correct: judgment.premiseCorrect,
      // Only fill reference_price when workstream H left it null - never overwrite.
      ...(row.reference_price == null && windows?.referencePrice != null ? { reference_price: windows.referencePrice } : {}),
    });
    audited++;
  }
  notes.push(`Discovery-filter audit: ${audited} DISCOVERED_FILTERED movers judged at decision time.`);
  return { audited, notes };
}

// ---------------------------------------------------------------------------
// 4. Risk-rejected outcome audit
// ---------------------------------------------------------------------------

interface RiskRejectionRecord {
  transactionId: string | null;
  traceId: string;
  side: string;
  rejectionGate: string | null;
  createdAt: string;
  reasoning: string | null;
  gates: Array<{ gateName: string; passed: boolean; detail: string | null }>;
  priceAtDecision: number | null;
}

function readRiskRejections(symbol: string, startIso: string, endIso: string): RiskRejectionRecord[] {
  const out: RiskRejectionRecord[] = [];
  try {
    const rows = sqliteDb.prepare(
      `SELECT transaction_id, trace_id, side, rejection_gate, created_at, reasoning
       FROM risk_assessments
       WHERE symbol = ? AND approved = 0 AND created_at >= ? AND created_at < ?
       ORDER BY created_at ASC`
    ).all(symbol.toUpperCase(), startIso, endIso) as Array<{
      transaction_id: string | null; trace_id: string; side: string;
      rejection_gate: string | null; created_at: string; reasoning: string | null;
    }>;
    for (const r of rows) {
      let gates: RiskRejectionRecord['gates'] = [];
      try {
        gates = (sqliteDb.prepare(
          `SELECT gate_name, passed, detail FROM risk_gate_results WHERE trace_id = ? ORDER BY sequence ASC`
        ).all(r.trace_id) as Array<{ gate_name: string; passed: number; detail: string | null }>)
          .map((g) => ({ gateName: g.gate_name, passed: g.passed === 1, detail: g.detail }));
      } catch { /* gate detail unavailable - record stays honest about the rejection itself */ }
      let priceAtDecision: number | null = null;
      if (r.transaction_id) {
        try {
          const ev = sqliteDb.prepare(
            `SELECT current_price FROM consensus_evidence WHERE transaction_id = ? AND current_price IS NOT NULL ORDER BY id ASC LIMIT 1`
          ).get(r.transaction_id) as { current_price: number | null } | undefined;
          priceAtDecision = ev?.current_price ?? null;
        } catch { /* no price snapshot - reference falls back to the decision bar close */ }
      }
      out.push({
        transactionId: r.transaction_id,
        traceId: r.trace_id,
        side: r.side,
        rejectionGate: r.rejection_gate,
        createdAt: r.created_at,
        reasoning: r.reasoning,
        gates,
        priceAtDecision,
      });
    }
  } catch {
    /* risk tables unavailable - caller records the gap */
  }
  return out;
}

/**
 * For every RISK_REJECTED mover: record the rejecting gate(s), the real decision
 * timestamp, the reference price (stored price at decision, else the decision
 * bar close), and causal outcome windows. Diagnostic only - a rejection that
 * "would have worked" is a research observation, never a reason to loosen the gate.
 */
export async function auditRiskRejected(
  tradingDate: string,
  deps: { fetchBars?: BarProvider } = {},
): Promise<{ audited: number; notes: string[] }> {
  const notes: string[] = [];
  const rows = readMoverRows(tradingDate, ['RISK_REJECTED']);
  if (!moverCoverageAvailable()) {
    notes.push('mover_coverage table absent (workstream H 0093 not yet applied) - risk-rejection audit skipped.');
    return { audited: 0, notes };
  }
  const fetchBars = deps.fetchBars ?? recordedBarProvider;
  const startIso = `${tradingDate}T00:00:00.000Z`;
  const endIso = `${tradingDate}T23:59:59.999Z`;
  let audited = 0;

  for (const row of rows) {
    const sym = row.symbol.toUpperCase();
    const rejections = readRiskRejections(sym, startIso, endIso);
    const first = rejections[0] ?? null;

    let windows: OutcomeWindows | null = null;
    if (first) {
      windows = await computeOutcomeWindows(sym, first.createdAt, tradingDate, fetchBars, first.priceAtDecision);
    }

    const auditBlock = {
      rejectionCount: rejections.length,
      firstRejection: first ? {
        transactionId: first.transactionId,
        traceId: first.traceId,
        side: first.side,
        rejectionGate: first.rejectionGate,
        decisionAtIso: first.createdAt,
        reasoning: first.reasoning,
        gateResults: first.gates,
        storedPriceAtDecision: first.priceAtDecision,
      } : null,
      // Every rejection that day (a symbol can be rejected more than once).
      allRejections: rejections.map((r) => ({
        traceId: r.traceId,
        side: r.side,
        rejectionGate: r.rejectionGate,
        decisionAtIso: r.createdAt,
        failedGates: r.gates.filter((g) => !g.passed).map((g) => g.gateName),
      })),
      referencePrice: windows?.referencePrice ?? null,
      referenceSource: windows?.referenceSource ?? null,
      outcomeWindows: windows,
      eodMovePct: row.eod_move_pct,
      auditedAtIso: new Date().toISOString(),
    };
    updateMoverRow(tradingDate, row.symbol, {
      secondary_reasons: appendAuditNote(row.secondary_reasons, 'riskRejectionAudit', auditBlock),
      outcome_windows: windows ? mergeOutcomeWindows(row.outcome_windows, windows) : row.outcome_windows,
      ...(row.reference_price == null && windows?.referencePrice != null ? { reference_price: windows.referencePrice } : {}),
    });
    audited++;
  }
  notes.push(`Risk-rejection audit: ${audited} RISK_REJECTED movers recorded with gate, timestamp, and reference price.`);
  return { audited, notes };
}

// ---------------------------------------------------------------------------
// 5. Pre-market effectiveness (known-by)
// ---------------------------------------------------------------------------

/**
 * Determine, from real pre-market evidence, which pre-market sources knew a
 * symbol before the open. Measures the incremental value of the late refresh:
 * a mover known ONLY via refresh0915 (and not plan0400) is evidence the ~09:15
 * refresh added coverage the 04:00 plan lacked.
 *
 * Cutoffs (documented heuristics, not trading signals):
 * - plan0400: a trade_plans v1 row for the date created BEFORE the first
 *   premarket_focus_reports row of the day (the 04:00 build precedes the 09:15
 *   report); falls back to 12:00Z when no focus report exists.
 * - refresh0915: symbol named in any focus-report tier that day, OR a
 *   trade_plan_revisions row for the date, OR a v1 plan created at/after the cutoff.
 */
export function determinePremarketKnownBy(symbol: string, tradingDate: string): PremarketKnownBy {
  const sym = symbol.toUpperCase();
  const startIso = `${tradingDate}T00:00:00.000Z`;
  const endIso = `${tradingDate}T23:59:59.999Z`;
  const result: PremarketKnownBy = {
    plan0400: false, plan0400At: null,
    refresh0915: false, refresh0915At: null,
    fastLane: false, fastLaneAt: null,
    discovery: false, discoveryAt: null,
    sources: [],
  };
  const mark = (key: 'plan0400' | 'refresh0915' | 'fastLane' | 'discovery', at: string | null) => {
    result[key] = true;
    if (key === 'plan0400') result.plan0400At = at;
    else if (key === 'refresh0915') result.refresh0915At = at;
    else if (key === 'fastLane') result.fastLaneAt = at;
    else result.discoveryAt = at;
    if (!result.sources.includes(key)) result.sources.push(key);
  };

  try {
    // Focus reports for the date (drives the plan0400/refresh0915 cutoff).
    const reports = sqliteDb.prepare(
      `SELECT generated_at, primary_json, secondary_json, watch_json FROM premarket_focus_reports
       WHERE plan_date = ? ORDER BY generated_at ASC`
    ).all(tradingDate) as Array<{ generated_at: string; primary_json: string; secondary_json: string; watch_json: string }>;
    const cutoffIso = reports[0]?.generated_at ?? `${tradingDate}T12:00:00.000Z`;

    // plan0400: v1 plan created before the first focus report of the day.
    const v1 = sqliteDb.prepare(
      `SELECT created_at FROM trade_plans WHERE symbol = ? AND plan_date = ? AND refresh_version = 1 ORDER BY created_at ASC LIMIT 1`
    ).get(sym, tradingDate) as { created_at: string } | undefined;
    if (v1 && v1.created_at < cutoffIso) mark('plan0400', v1.created_at);

    // refresh0915: named in any focus-report tier...
    let inReportAt: string | null = null;
    for (const r of reports) {
      for (const tierJson of [r.primary_json, r.secondary_json, r.watch_json]) {
        try {
          const entries = JSON.parse(tierJson) as Array<{ symbol?: string }>;
          if (Array.isArray(entries) && entries.some((e) => (e?.symbol ?? '').toUpperCase() === sym)) {
            inReportAt = inReportAt ?? r.generated_at;
          }
        } catch { /* malformed tier json - skip */ }
      }
    }
    // ...or a later plan revision, or a v1 plan built at/after the cutoff.
    const rev = sqliteDb.prepare(
      `SELECT created_at FROM trade_plan_revisions WHERE symbol = ? AND plan_date = ? ORDER BY created_at ASC LIMIT 1`
    ).get(sym, tradingDate) as { created_at: string } | undefined;
    if (inReportAt) mark('refresh0915', inReportAt);
    else if (rev) mark('refresh0915', rev.created_at);
    else if (v1 && v1.created_at >= cutoffIso) mark('refresh0915', v1.created_at);

    // fastLane: any Fast Lane candidate/evaluation event that day.
    const fast = sqliteDb.prepare(
      `SELECT MIN(ts) AS first_ts FROM observability_events
       WHERE symbol = ? AND category = 'FAST_LANE' AND ts >= ? AND ts < ?`
    ).get(sym, Date.parse(startIso), Date.parse(endIso)) as { first_ts: number | null } | undefined;
    if (fast?.first_ts != null) mark('fastLane', new Date(fast.first_ts).toISOString());

    // discovery: any lineage decision (admitted or filtered) that day.
    const disc = sqliteDb.prepare(
      `SELECT MIN(ts) AS first_ts FROM observability_events
       WHERE symbol = ? AND event_type IN ('DISCOVERY_CANDIDATE_ADMITTED','DISCOVERY_CANDIDATE_FILTERED')
       AND ts >= ? AND ts < ?`
    ).get(sym, Date.parse(startIso), Date.parse(endIso)) as { first_ts: number | null } | undefined;
    if (disc?.first_ts != null) mark('discovery', new Date(disc.first_ts).toISOString());
  } catch {
    /* a missing pre-market table degrades to "unknown" sources, never fabricated */
  }
  return result;
}

/**
 * Persist premarket_known_by for every mover row of the date.
 *
 * Persisted shape is exactly { plan0400, refresh0915, fastLane, discovery } -
 * workstream H's documented column contract (schema.ts). The richer
 * PremarketKnownBy (evidence timestamps, sources list) stays available from
 * determinePremarketKnownBy() for programmatic use; the column keeps the
 * 4-key shape every reader was built against.
 */
export function recordPremarketKnownBy(tradingDate: string): { recorded: number; notes: string[] } {
  const notes: string[] = [];
  if (!moverCoverageAvailable()) {
    notes.push('mover_coverage table absent (workstream H 0093 not yet applied) - premarket known-by skipped.');
    return { recorded: 0, notes };
  }
  const rows = readMoverRows(tradingDate);
  let recorded = 0;
  for (const row of rows) {
    const kb = determinePremarketKnownBy(row.symbol, tradingDate);
    updateMoverRow(tradingDate, row.symbol, {
      premarket_known_by: JSON.stringify({
        plan0400: kb.plan0400,
        refresh0915: kb.refresh0915,
        fastLane: kb.fastLane,
        discovery: kb.discovery,
      }),
    });
    recorded++;
  }
  notes.push(`Pre-market known-by recorded for ${recorded} movers.`);
  return { recorded, notes };
}

// ---------------------------------------------------------------------------
// 6. Data readiness at open (diagnostic, not a blind 100% target)
// ---------------------------------------------------------------------------

/**
 * For PRIMARY-tier focus-report entries (latest refresh version of the date),
 * classify data readiness with the WHY for each failure:
 * - FRESH: entry.freshness.dataFresh is true.
 * - SUBSCRIBED_FRESH_UNKNOWN: actively subscribed but plan-data freshness unknown.
 * - NO_SUBSCRIPTION_SLOT: not subscribed and no reservation (or reservation expired).
 * - RESERVATION_DENIED: premarket_data_reservations has a DENIED row.
 * - RESERVED_BUT_STALE: reservation ACTIVE yet data not fresh.
 * - STALE_QUOTE: entry.dataReadiness.missing names quote/data gaps.
 * - RESCUE_DENIED: reservation granted but the follow-on data rescue was denied.
 * - PLAN_NOT_LIVE: plan status not live/valid.
 */
export function assessDataReadiness(tradingDate: string): { entries: DataReadinessEntry[]; readinessRate: number | null; notes: string[] } {
  const notes: string[] = [];
  const entries: DataReadinessEntry[] = [];
  try {
    const report = sqliteDb.prepare(
      `SELECT primary_json FROM premarket_focus_reports WHERE plan_date = ? ORDER BY refresh_version DESC, generated_at DESC LIMIT 1`
    ).get(tradingDate) as { primary_json: string } | undefined;
    if (!report) {
      notes.push('No premarket_focus_reports row for the date - nothing to assess.');
      return { entries, readinessRate: null, notes };
    }
    let primary: Array<Record<string, unknown>>;
    try {
      primary = JSON.parse(report.primary_json) as Array<Record<string, unknown>>;
      if (!Array.isArray(primary)) primary = [];
    } catch {
      notes.push('primary_json malformed - cannot assess.');
      return { entries, readinessRate: null, notes };
    }

    for (const e of primary) {
      const symbol = String(e.symbol ?? '').toUpperCase();
      if (!symbol) continue;
      const freshness = (e.freshness ?? {}) as { dataFresh?: boolean; planStatus?: string };
      const dataReadiness = (e.dataReadiness ?? {}) as { missing?: string[] };
      const subscriptionState = typeof e.subscriptionState === 'string' ? e.subscriptionState : null;

      const reservation = sqliteDb.prepare(
        `SELECT status, release_reason FROM premarket_data_reservations
         WHERE symbol = ? AND requested_at >= ? AND requested_at < ?
         ORDER BY requested_at DESC LIMIT 1`
      ).get(symbol, `${tradingDate}T00:00:00.000Z`, `${tradingDate}T23:59:59.999Z`) as
        { status: string; release_reason: string | null } | undefined;

      let readinessClass: DataReadinessClass;
      let why: string;
      const dataFresh = freshness.dataFresh === true;
      const subscribed = subscriptionState === 'SUBSCRIBED_ANCHOR' || subscriptionState === 'SUBSCRIBED_DYNAMIC';

      if (dataFresh) {
        readinessClass = 'FRESH';
        why = 'Focus entry reports fresh plan data at the open.';
      } else if (reservation?.status === 'DENIED') {
        readinessClass = 'RESERVATION_DENIED';
        why = `Data reservation denied: ${reservation.release_reason ?? 'no reason recorded'}.`;
      } else if (reservation && /rescue/i.test(reservation.release_reason ?? '')) {
        readinessClass = 'RESCUE_DENIED';
        why = `Reservation granted but the follow-on data rescue was denied: ${reservation.release_reason}.`;
      } else if (reservation?.status === 'ACTIVE') {
        readinessClass = 'RESERVED_BUT_STALE';
        why = 'Reservation ACTIVE yet the focus entry does not report fresh data - slot held, data not flowing.';
      } else if (!subscribed && (subscriptionState === 'NOT_SUBSCRIBED' || subscriptionState === 'UNKNOWN' || !subscriptionState)) {
        readinessClass = 'NO_SUBSCRIPTION_SLOT';
        why = `Not subscribed at the open (state: ${subscriptionState ?? 'unknown'}) with no live reservation - capacity, not eligibility.`;
      } else if (Array.isArray(dataReadiness.missing) && dataReadiness.missing.length > 0) {
        readinessClass = 'STALE_QUOTE';
        why = `Missing data inputs at the open: ${dataReadiness.missing.join(', ')}.`;
      } else if (subscribed) {
        readinessClass = 'SUBSCRIBED_FRESH_UNKNOWN';
        why = 'Subscribed at the open but plan-data freshness not confirmed.';
      } else if (freshness.planStatus && !/live|valid|ready/i.test(freshness.planStatus)) {
        readinessClass = 'PLAN_NOT_LIVE';
        why = `Plan status at the open: ${freshness.planStatus}.`;
      } else {
        readinessClass = 'UNKNOWN';
        why = 'Insufficient evidence to classify - recorded as unknown, never assumed fresh.';
      }

      entries.push({
        symbol,
        tier: 'PRIMARY',
        readinessClass,
        why,
        subscriptionState,
        dataFresh: typeof freshness.dataFresh === 'boolean' ? freshness.dataFresh : null,
        reservationStatus: reservation?.status ?? null,
      });
    }
  } catch {
    notes.push('Data-readiness assessment hit a storage error - partial results only.');
  }
  const readinessRate = entries.length > 0
    ? entries.filter((e) => e.readinessClass === 'FRESH').length / entries.length
    : null;
  notes.push(`Data readiness: ${entries.length} PRIMARY entries, ${entries.filter((e) => e.readinessClass === 'FRESH').length} fresh.`);
  return { entries, readinessRate, notes };
}

// ---------------------------------------------------------------------------
// 7. Session metrics
// ---------------------------------------------------------------------------

function countWhere(sql: string, ...params: unknown[]): number {
  try {
    const row = sqliteDb.prepare(sql).get(...params) as { c: number } | undefined;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

function distinctSymbols(sql: string, ...params: unknown[]): Set<string> {
  const out = new Set<string>();
  try {
    const rows = sqliteDb.prepare(sql).all(...params) as Array<{ symbol: string }>;
    for (const r of rows) if (r.symbol) out.add(String(r.symbol).toUpperCase());
  } catch { /* missing table -> empty set */ }
  return out;
}

/**
 * Compute the full session scorecard and upsert it into
 * reflection_session_metrics. Every rate is a plain share over a real,
 * counted denominator; a denominator of zero yields null, never 0% masquerading
 * as a measured zero.
 */
export function computeSessionMetrics(tradingDate: string, readinessRate: number | null): SessionMetrics {
  const startIso = `${tradingDate}T00:00:00.000Z`;
  const endIso = `${tradingDate}T23:59:59.999Z`;
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);

  const fateCounts = new Map<string, number>();
  let moversTotal: number | null = null;
  let moversSeen: number | null = null;
  if (moverCoverageAvailable()) {
    const rows = sqliteDb.prepare(
      `SELECT primary_fate, COUNT(*) c FROM mover_coverage WHERE trading_date = ? GROUP BY primary_fate`
    ).all(tradingDate) as Array<{ primary_fate: string | null; c: number }>;
    for (const r of rows) fateCounts.set(r.primary_fate ?? 'UNKNOWN', r.c);
    moversTotal = [...fateCounts.values()].reduce((a, b) => a + b, 0);
    moversSeen = moversTotal - (fateCounts.get('NEVER_SEEN') ?? 0);
  }
  const rate = (num: number, den: number | null): number | null =>
    den != null && den > 0 ? num / den : null;

  const neverSeenRate = moversTotal != null ? rate(fateCounts.get('NEVER_SEEN') ?? 0, moversTotal) : null;
  const discoveryFilterRate = moversSeen != null ? rate(fateCounts.get('DISCOVERED_FILTERED') ?? 0, moversSeen) : null;

  // Focus recall: share of major movers named in the latest focus report (any tier).
  let focusRecall: number | null = null;
  if (moversTotal != null && moversTotal > 0) {
    try {
      const report = sqliteDb.prepare(
        `SELECT primary_json, secondary_json, watch_json FROM premarket_focus_reports WHERE plan_date = ? ORDER BY refresh_version DESC, generated_at DESC LIMIT 1`
      ).get(tradingDate) as { primary_json: string; secondary_json: string; watch_json: string } | undefined;
      if (report) {
        const named = new Set<string>();
        for (const tj of [report.primary_json, report.secondary_json, report.watch_json]) {
          try {
            const arr = JSON.parse(tj) as Array<{ symbol?: string }>;
            if (Array.isArray(arr)) for (const e of arr) if (e?.symbol) named.add(String(e.symbol).toUpperCase());
          } catch { /* skip malformed tier */ }
        }
        const moverSyms = distinctSymbols(`SELECT symbol FROM mover_coverage WHERE trading_date = ?`, tradingDate);
        let hit = 0;
        for (const s of moverSyms) if (named.has(s)) hit++;
        focusRecall = moverSyms.size > 0 ? hit / moverSyms.size : null;
      }
    } catch { /* no focus report table - stays null */ }
  }

  // Catalyst coverage: share of movers with real news coverage (same lineage
  // signal PostMarketAnalysis.buildFindings uses).
  let catalystCoverage: number | null = null;
  if (moversTotal != null && moversTotal > 0) {
    const moverSyms = distinctSymbols(`SELECT symbol FROM mover_coverage WHERE trading_date = ?`, tradingDate);
    const withNews = distinctSymbols(
      `SELECT DISTINCT symbol FROM observability_events WHERE event_type IN ('NEWS_ANALYZED','NEWS_CLUSTER_CREATED') AND ts >= ? AND ts < ?`,
      startMs, endMs,
    );
    let hit = 0;
    for (const s of moverSyms) if (withNews.has(s)) hit++;
    catalystCoverage = moverSyms.size > 0 ? hit / moverSyms.size : null;
  }

  // Evaluation rate: admitted movers that received a real quant evaluation.
  let evaluationRate: number | null = null;
  let validTriggerRate: number | null = null;
  const admittedSyms = moverCoverageAvailable()
    ? distinctSymbols(`SELECT symbol FROM mover_coverage WHERE trading_date = ? AND primary_fate != 'DISCOVERED_FILTERED' AND primary_fate != 'NEVER_SEEN'`, tradingDate)
    : new Set<string>();
  if (admittedSyms.size > 0) {
    const evaluated = distinctSymbols(
      `SELECT DISTINCT symbol FROM quant_assessments WHERE created_at >= ? AND created_at < ?`,
      startIso, endIso,
    );
    let evalHit = 0;
    const evaluatedMovers = new Set<string>();
    for (const s of admittedSyms) if (evaluated.has(s)) { evalHit++; evaluatedMovers.add(s); }
    evaluationRate = evalHit / admittedSyms.size;
    // Valid trigger rate: evaluated movers that produced a real strategy signal
    // with entry_met=1 (strategy_engine_signals is the real, append-only signal trail).
    if (evaluatedMovers.size > 0) {
      const triggered = distinctSymbols(
        `SELECT DISTINCT symbol FROM strategy_engine_signals WHERE entry_met = 1 AND created_at >= ? AND created_at < ?`,
        startIso, endIso,
      );
      let trigHit = 0;
      for (const s of evaluatedMovers) if (triggered.has(s)) trigHit++;
      validTriggerRate = trigHit / evaluatedMovers.size;
    }
  }

  // Consensus approval rate: share of real consensus evaluations that approved.
  let consensusApprovalRate: number | null = null;
  try {
    const total = countWhere(`SELECT COUNT(*) c FROM consensus_decisions WHERE created_at >= ? AND created_at < ?`, startIso, endIso);
    if (total > 0) {
      const approved = countWhere(`SELECT COUNT(*) c FROM consensus_decisions WHERE approved = 1 AND created_at >= ? AND created_at < ?`, startIso, endIso);
      consensusApprovalRate = approved / total;
    }
  } catch { /* stays null */ }

  // Primary precision: PRIMARY focus selections that developed a legitimate
  // setup (reached a real transaction cycle or a valid entry trigger).
  // "Better discovery, not more symbols."
  let primaryPrecision: number | null = null;
  try {
    const report = sqliteDb.prepare(
      `SELECT primary_json FROM premarket_focus_reports WHERE plan_date = ? ORDER BY refresh_version DESC, generated_at DESC LIMIT 1`
    ).get(tradingDate) as { primary_json: string } | undefined;
    if (report) {
      const arr = JSON.parse(report.primary_json) as Array<{ symbol?: string }>;
      const primarySyms = new Set<string>();
      if (Array.isArray(arr)) for (const e of arr) if (e?.symbol) primarySyms.add(String(e.symbol).toUpperCase());
      if (primarySyms.size > 0) {
        const transacted = distinctSymbols(`SELECT DISTINCT symbol FROM transactions WHERE opened_at >= ? AND opened_at < ?`, startIso, endIso);
        const triggered = distinctSymbols(
          `SELECT DISTINCT symbol FROM strategy_engine_signals WHERE entry_met = 1 AND created_at >= ? AND created_at < ?`,
          startIso, endIso,
        );
        let hit = 0;
        for (const s of primarySyms) if (transacted.has(s) || triggered.has(s)) hit++;
        primaryPrecision = hit / primarySyms.size;
      }
    }
  } catch { /* stays null */ }

  const detail = {
    fateCounts: Object.fromEntries(fateCounts),
    admittedMovers: admittedSyms.size,
    readinessRate,
  };

  return {
    tradingDate,
    moversTotal,
    moversSeen,
    focusRecall,
    primaryDataReadiness: readinessRate,
    catalystCoverage,
    neverSeenRate,
    discoveryFilterRate,
    evaluationRate,
    validTriggerRate,
    consensusApprovalRate,
    primaryPrecision,
    detailJson: JSON.stringify(detail),
  };
}

/** Upsert the session metrics row (idempotent per trading date). */
export function persistSessionMetrics(m: SessionMetrics): void {
  sqliteDb.prepare(
    `INSERT INTO reflection_session_metrics
       (trading_date, movers_total, movers_seen, focus_recall, primary_data_readiness,
        catalyst_coverage, never_seen_rate, discovery_filter_rate, evaluation_rate,
        valid_trigger_rate, consensus_approval_rate, primary_precision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(trading_date) DO UPDATE SET
       movers_total = excluded.movers_total, movers_seen = excluded.movers_seen,
       focus_recall = excluded.focus_recall, primary_data_readiness = excluded.primary_data_readiness,
       catalyst_coverage = excluded.catalyst_coverage, never_seen_rate = excluded.never_seen_rate,
       discovery_filter_rate = excluded.discovery_filter_rate, evaluation_rate = excluded.evaluation_rate,
       valid_trigger_rate = excluded.valid_trigger_rate, consensus_approval_rate = excluded.consensus_approval_rate,
       primary_precision = excluded.primary_precision, created_at = excluded.created_at`
  ).run(
    m.tradingDate, m.moversTotal, m.moversSeen, m.focusRecall, m.primaryDataReadiness,
    m.catalystCoverage, m.neverSeenRate, m.discoveryFilterRate, m.evaluationRate,
    m.validTriggerRate, m.consensusApprovalRate, m.primaryPrecision, new Date().toISOString(),
  );
}

// ---------------------------------------------------------------------------
// 8. The hook: callOutcomeAudits(tradingDate)
// ---------------------------------------------------------------------------

export interface CallOutcomeAuditsDeps extends FilterAuditDeps {
  fetchBars?: BarProvider;
}

/**
 * Run the full post-market outcome-audit suite for one trading date.
 * Called from dailyReflection.ts's callOutcomeAudits hook. Read-only except
 * for its own audit columns (mover_coverage audit fields + one
 * reflection_session_metrics row). Never touches trading state.
 */
export async function callOutcomeAudits(tradingDate: string, deps: CallOutcomeAuditsDeps = {}): Promise<OutcomeAuditSummary> {
  const notes: string[] = [];
  const summary: OutcomeAuditSummary = {
    tradingDate,
    moverCoverageAvailable: moverCoverageAvailable(),
    filteredAudited: 0,
    riskRejectedAudited: 0,
    knownByRecorded: 0,
    dataReadiness: { entries: 0, fresh: 0, failing: 0 },
    metricsPersisted: false,
    notes,
  };

  if (!tableExists('reflection_session_metrics')) {
    notes.push('reflection_session_metrics table absent (0094 not applied) - audits run in-memory only, metrics not persisted.');
  }

  const filtered = await auditDiscoveryFiltered(tradingDate, deps);
  summary.filteredAudited = filtered.audited;
  notes.push(...filtered.notes);

  const rejected = await auditRiskRejected(tradingDate, deps);
  summary.riskRejectedAudited = rejected.audited;
  notes.push(...rejected.notes);

  const knownBy = recordPremarketKnownBy(tradingDate);
  summary.knownByRecorded = knownBy.recorded;
  notes.push(...knownBy.notes);

  const readiness = assessDataReadiness(tradingDate);
  summary.dataReadiness = {
    entries: readiness.entries.length,
    fresh: readiness.entries.filter((e) => e.readinessClass === 'FRESH').length,
    failing: readiness.entries.filter((e) => e.readinessClass !== 'FRESH' && e.readinessClass !== 'SUBSCRIBED_FRESH_UNKNOWN').length,
  };
  notes.push(...readiness.notes);

  if (tableExists('reflection_session_metrics')) {
    const metrics = computeSessionMetrics(tradingDate, readiness.readinessRate);
    persistSessionMetrics(metrics);
    summary.metricsPersisted = true;
    notes.push(`Session metrics persisted for ${tradingDate}.`);
  }

  return summary;
}
