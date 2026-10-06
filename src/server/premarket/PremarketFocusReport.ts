/**
 * Pre-market focus report builder (2026-10-06, workstream D, local-only).
 *
 * Builds the ~09:15 focus report: every trade-plan candidate for a trading
 * date is scored with the decomposed pre-market opportunity score
 * (PremarketOpportunityScore.ts) and ranked into attention tiers:
 * PRIMARY / SECONDARY / WATCH / REJECTED.
 *
 * TIER SEMANTICS (hard rule): tiers mean "deserves attention in the
 * pre-market review", NEVER "actionable". This report never emits trade
 * ideas, never touches ChiefTrader / RiskEngine / OMS / BrokerManager, and
 * never carries a direction/side — the per-symbol entries deliberately omit
 * the trade plan's BUY/SELL direction (including it would imply an actionable
 * signal, which this report must never do). Selection must NEVER imply
 * actionable; it only orders what a human reviews first.
 *
 * Candidate input resolution (in order):
 *   1. Explicit `candidateInputs` map (tests / operator override) — scored fresh.
 *   2. The plan row's `scoreDecompositionJson` (persisted by workstream B's
 *      late refresh, which calls scorePremarketCandidate with real pre-market
 *      inputs) — used as-is when it parses to a valid breakdown.
 *   3. Default derivation from the plan row: only fields the trade_plans row
 *      really carries. Raw pre-market numbers (gap %, pre-market move, dollar
 *      volume, spreads, RS values) are NOT persisted on the plan row, so they
 *      are honestly left undefined -> scored 0 and listed in inputsMissing.
 *      Plan catalyst strings are descriptive evidence for the report's
 *      catalyst field, not scored sentiment/recency evidence.
 *
 * Subscription state is read (read-only) from MarketDataWorker.getActiveSlots()
 * via dynamic import with try/catch -> 'UNKNOWN' on any failure, the same
 * fail-soft pattern as SessionLifecycle.getRefinedSnapshot().
 *
 * Wiring: production boot must call installPremarketFocusSubscribers() (from
 * premarketFocusEvents.ts) once so PREMARKET_REFRESH_COMPLETED regenerates the
 * report. That boot call is integration work outside this module (this module
 * must not import server.ts or any boot file).
 */
import type {
  PremarketCandidateInput,
  PremarketScoreBreakdown,
  PremarketScoreComponents,
} from './PremarketOpportunityScore';
import { scorePremarketCandidate } from './PremarketOpportunityScore';
import { premarketFocusConfig } from '../config/premarketFocus';
import type { tradePlans } from '../db/schema';

export type TradePlanRow = typeof tradePlans.$inferSelect;

export type FocusTier = 'PRIMARY' | 'SECONDARY' | 'WATCH' | 'REJECTED';
export type SubscriptionState = 'SUBSCRIBED_ANCHOR' | 'SUBSCRIBED_DYNAMIC' | 'NOT_SUBSCRIBED' | 'UNKNOWN';

export interface FocusReportCatalyst {
  /** Descriptive catalyst labels from the trade plan (never scored as sentiment). */
  labels: string[];
  type: string | null;
  sourceCount: number | null;
  /** True when the score actually consumed a real PremarketCatalystInput. */
  scored: boolean;
}

export interface FocusReportFreshness {
  planStatus: string;
  validUntil: string;
  /** Plan-data freshness (plan live and within its validity window). Not quote freshness. */
  dataFresh: boolean;
  planAgeMinutes: number | null;
}

export interface FocusReportDataReadiness {
  available: string[];
  missing: string[];
  /** available / (available + missing), 0..1. */
  completeness: number;
}

export interface FocusReportEntry {
  symbol: string;
  tier: FocusTier;
  total: number;
  components: PremarketScoreComponents;
  weights: Record<keyof PremarketScoreComponents, number>;
  inputsMissing: string[];
  /** Direction-blind attention reasons, strongest contribution first.
   *  For REJECTED entries this explains why the cutoff was missed. */
  whySelected: string[];
  catalyst: FocusReportCatalyst;
  freshness: FocusReportFreshness;
  strategyApplicability: string[];
  dataReadiness: FocusReportDataReadiness;
  subscriptionState: SubscriptionState;
  /** The plan's own BUY/SELL direction is DELIBERATELY absent: carrying it
   *  would imply an actionable signal. */
}

export interface FocusReportMetrics {
  candidateCount: number;
  scoredCount: number;
  avgTotal: number;
  missingInputHistogram: Record<string, number>;
  refreshedAt: string | null;
}

export interface FocusReportSources {
  plansRead: number;
  symbolsScored: number;
  planStatuses: Record<string, number>;
}

export interface FocusReport {
  tradingDate: string;
  refreshVersion: number;
  generatedAt: string;
  refreshedAt: string | null;
  tiers: Record<FocusTier, FocusReportEntry[]>;
  metrics: FocusReportMetrics;
  sources: FocusReportSources;
}

export interface BuildFocusReportOptions {
  /** Fixture injection for tests; default: getTradePlansForDate(tradingDate). */
  plans?: TradePlanRow[];
  /** Explicit per-symbol scoring inputs; overrides plan-derived/persisted breakdowns. */
  candidateInputs?: Map<string, PremarketCandidateInput>;
  now?: Date;
  refreshedAt?: string | null;
}

const TIERS: FocusTier[] = ['PRIMARY', 'SECONDARY', 'WATCH', 'REJECTED'];

export function tierForTotal(total: number): FocusTier {
  const cutoffs = premarketFocusConfig.tierCutoffs;
  if (total >= cutoffs.primary) return 'PRIMARY';
  if (total >= cutoffs.secondary) return 'SECONDARY';
  if (total >= cutoffs.watch) return 'WATCH';
  return 'REJECTED';
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function isValidBreakdown(value: unknown): value is PremarketScoreBreakdown {
  if (value == null || typeof value !== 'object') return false;
  const b = value as Record<string, unknown>;
  const c = b.components as Record<string, unknown> | undefined;
  return (
    typeof b.symbol === 'string' &&
    typeof b.total === 'number' &&
    Number.isFinite(b.total) &&
    c != null &&
    typeof c === 'object' &&
    ['overnightGap', 'preMarketPctChange', 'catalystPresence', 'signedSentiment', 'liquidity'].every(
      (k) => typeof c[k] === 'number',
    ) &&
    Array.isArray(b.inputsMissing)
  );
}

/** Default candidate input derived ONLY from fields the trade_plans row
 *  really carries. Everything else is honestly left absent. */
function candidateInputFromPlan(plan: TradePlanRow, now: Date): PremarketCandidateInput {
  const validUntilMs = Date.parse(plan.validUntil);
  const liveStatus = plan.status !== 'EXPIRED' && plan.status !== 'INVALIDATED' && plan.status !== 'CLOSED';
  return {
    symbol: plan.symbol,
    // Plan rows carry no spread evidence: explicit unknown -> fail-open
    // neutral (per the input's documented semantics), not a fabricated value.
    spreadBps: null,
    dataFresh: liveStatus && Number.isFinite(validUntilMs) && now.getTime() <= validUntilMs,
  };
}

/**
 * Resolve the scoring breakdown for one plan: explicit candidate inputs win,
 * then workstream B's persisted scoreDecompositionJson, then the default
 * honest-missing derivation from the plan row. Exported for the CLI, which
 * shows per-symbol scores consistently with the persisted report.
 */
export function resolvePlanBreakdown(
  plan: TradePlanRow,
  opts: BuildFocusReportOptions,
  now: Date,
): { breakdown: PremarketScoreBreakdown; input: PremarketCandidateInput; fromPersisted: boolean } {
  const explicit = opts.candidateInputs?.get(plan.symbol);
  if (explicit) {
    return { breakdown: scorePremarketCandidate(explicit), input: explicit, fromPersisted: false };
  }
  if (plan.scoreDecompositionJson) {
    try {
      const parsed: unknown = JSON.parse(plan.scoreDecompositionJson);
      if (isValidBreakdown(parsed) && parsed.symbol === plan.symbol) {
        // Rebuild the minimal input view for display fields from the
        // breakdown itself (weights/inputsMissing are authoritative here).
        const input: PremarketCandidateInput = {
          symbol: plan.symbol,
          strategyApplicability: [],
          dataFresh: false,
          spreadBps: null,
        };
        return { breakdown: parsed, input, fromPersisted: true };
      }
    } catch {
      // Fall through to default derivation; a corrupt persisted breakdown
      // must not kill the report.
    }
  }
  const input = candidateInputFromPlan(plan, now);
  return { breakdown: scorePremarketCandidate(input), input, fromPersisted: false };
}

function fmtSignedPct(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

function fmtDollars(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

/**
 * RVOL honesty (2026-10-06, workstream E verdict PREMARKET_RVOL_UNAVAILABLE):
 * there is no pre-market time-of-day expected-volume curve, so a null, zero,
 * or otherwise non-positive relative-volume multiple in a pre-market context
 * must render as PREMARKET_RVOL_UNAVAILABLE — never as "0.00x", which would
 * fabricate a measured zero. The "Relative volume 0.00x (score N/A)" string
 * itself is produced by TradePlanBuilder.buildThesis — not this module's file,
 * do not touch; this module maps it at its own display boundary instead.
 */
export function formatPremarketRvol(rawMultiple: number | null | undefined): string {
  if (rawMultiple == null || !Number.isFinite(rawMultiple) || rawMultiple <= 0) {
    return 'PREMARKET_RVOL_UNAVAILABLE';
  }
  return `${rawMultiple.toFixed(2)}x`;
}

/** Extract the plan's relative-volume component evidence, if the plan row carries it. */
function planRelativeVolumeComponent(plan: TradePlanRow | null): { score: number | null; available: boolean } | null {
  if (!plan?.componentScoresJson) return null;
  try {
    const parsed = JSON.parse(plan.componentScoresJson) as { relativeVolume?: unknown };
    const rv = parsed?.relativeVolume as { score?: unknown; available?: unknown } | undefined;
    if (rv == null || typeof rv !== 'object') return null;
    return {
      score: typeof rv.score === 'number' && Number.isFinite(rv.score) ? rv.score : null,
      available: rv.available === true,
    };
  } catch {
    return null;
  }
}

/**
 * Display line for the plan's relative-volume evidence, RVOL-honest: an
 * unavailable/null/zero reading in this pre-market context renders as
 * PREMARKET_RVOL_UNAVAILABLE, never "0.00x". Returns null when the plan row
 * carries no relative-volume evidence at all.
 */
export function planRvolDisplayLine(plan: TradePlanRow | null): string | null {
  const comp = planRelativeVolumeComponent(plan);
  if (!comp) return null;
  if (comp.available && comp.score != null && comp.score > 0) {
    return `relative volume score ${comp.score.toFixed(2)}`;
  }
  return `relative volume ${formatPremarketRvol(null)}`;
}

/** Direction-blind attention reasons, strongest contribution first. */
function buildWhySelected(
  plan: TradePlanRow | null,
  input: PremarketCandidateInput,
  breakdown: PremarketScoreBreakdown,
): string[] {
  const w = breakdown.weights;
  const c = breakdown.components;
  const contrib = (k: keyof PremarketScoreComponents): number => (w[k] ?? 0) * (c[k] ?? 0);
  const scored = (v: number | undefined | null): boolean => typeof v === 'number' && Number.isFinite(v);

  const candidates: Array<{ text: string; rank: number }> = [];
  const push = (text: string, key: keyof PremarketScoreComponents): void => {
    candidates.push({ text, rank: Math.abs(contrib(key)) });
  };

  if (scored(input.overnightGapPct) && c.overnightGap > 0) {
    push(`overnight gap ${fmtSignedPct(input.overnightGapPct as number)}`, 'overnightGap');
  }
  if (scored(input.preMarketPctChange) && c.preMarketPctChange > 0) {
    push(`pre-market move ${fmtSignedPct(input.preMarketPctChange as number)}`, 'preMarketPctChange');
  }
  if (input.catalyst && c.catalystPresence > 0) {
    const src = input.catalyst.source ? ` (${input.catalyst.source})` : '';
    push(`catalyst present${src}`, 'catalystPresence');
    if (c.catalystRecency > 0.5) push(`catalyst ${Math.round(input.catalyst.recencyMinutes)}m old (fresh)`, 'catalystRecency');
  }
  if (c.signedSentiment !== 0) {
    // Contextual note only — never phrased as a direction.
    push(
      `${c.signedSentiment > 0 ? 'positive' : 'negative'} sentiment context (attention ${c.signedSentiment > 0 ? 'raised' : 'dampened'}, not a direction)`,
      'signedSentiment',
    );
  }
  if (scored(input.dollarVolume) && c.liquidity > 0) {
    push(`liquid (${fmtDollars(input.dollarVolume as number)} recent dollar volume)`, 'liquidity');
  } else if (scored(input.advShares) && c.liquidity > 0) {
    push(`liquid (${Math.round(input.advShares as number).toLocaleString('en-US')} avg daily shares)`, 'liquidity');
  }
  if (input.spreadBps != null && c.spreadQuality >= 0.8) {
    push(`tight spread (${input.spreadBps}bps)`, 'spreadQuality');
  }
  if (scored(input.sectorRelativeStrength) && c.sectorRelativeStrength >= 0.6) {
    push('strong vs sector', 'sectorRelativeStrength');
  }
  if (scored(input.marketRelativeStrength) && c.marketRelativeStrength >= 0.6) {
    push('strong vs market', 'marketRelativeStrength');
  }
  if (input.strategyApplicability && input.strategyApplicability.length > 0) {
    push(
      `${input.strategyApplicability.length} applicable ${input.strategyApplicability.length === 1 ? 'strategy' : 'strategies'}: ${input.strategyApplicability.slice(0, 3).join(', ')}`,
      'strategyApplicability',
    );
  }

  candidates.sort((a, b) => b.rank - a.rank);
  const reasons = candidates.filter((r) => r.rank > 0).slice(0, 4).map((r) => r.text);

  // Plan evidence the score doesn't consume: relative volume, RVOL-honest
  // (PREMARKET_RVOL_UNAVAILABLE, never a fabricated "0.00x").
  const rvolLine = planRvolDisplayLine(plan);
  if (rvolLine) reasons.push(rvolLine);

  if (plan) {
    reasons.push(
      `TradePlan rank #${plan.rankAtCreation} (${plan.setupType}), confluence ${(plan.confluenceScore ?? 0).toFixed(2)}`,
    );
  }
  return reasons;
}

async function resolveSubscriptionStates(symbols: string[]): Promise<Map<string, SubscriptionState>> {
  const result = new Map<string, SubscriptionState>();
  try {
    // Read-only: which symbols hold a real streaming slot right now.
    const { marketDataWorker } = await import('../services/MarketDataWorker');
    const bySymbol = new Map(marketDataWorker.getActiveSlots().map((s) => [s.symbol, s.type] as const));
    for (const symbol of symbols) {
      const t = bySymbol.get(symbol);
      result.set(
        symbol,
        t === 'ANCHOR' ? 'SUBSCRIBED_ANCHOR' : t === 'DYNAMIC' ? 'SUBSCRIBED_DYNAMIC' : 'NOT_SUBSCRIBED',
      );
    }
  } catch {
    for (const symbol of symbols) result.set(symbol, 'UNKNOWN');
  }
  return result;
}

function dedupePlans(plans: TradePlanRow[]): TradePlanRow[] {
  const bySymbol = new Map<string, TradePlanRow>();
  for (const plan of plans) {
    const prev = bySymbol.get(plan.symbol);
    if (
      !prev ||
      (plan.rankAtCreation ?? Number.MAX_SAFE_INTEGER) < (prev.rankAtCreation ?? Number.MAX_SAFE_INTEGER) ||
      (plan.rankAtCreation === prev.rankAtCreation && plan.createdAt > prev.createdAt)
    ) {
      bySymbol.set(plan.symbol, plan);
    }
  }
  return [...bySymbol.values()];
}

/**
 * Build the pre-market focus report for a trading date + refresh version,
 * persist it to premarket_focus_reports (upsert on (plan_date,
 * refresh_version)), and emit PREMARKET_CANDIDATE_SCORED per candidate.
 * Read-only with respect to trading: never emits trade ideas, never touches
 * ChiefTrader/RiskEngine/OMS.
 */
export async function buildFocusReport(
  tradingDate: string,
  refreshVersion: number,
  opts: BuildFocusReportOptions = {},
): Promise<FocusReport> {
  const now = opts.now ?? new Date();
  const cfg = premarketFocusConfig;

  let plans: TradePlanRow[];
  if (opts.plans) {
    plans = opts.plans;
  } else {
    const { getTradePlansForDate } = await import('../continuous/TradePlanBuilder');
    plans = await getTradePlansForDate(tradingDate);
  }
  const uniquePlans = dedupePlans(plans.filter((p) => p.planDate === tradingDate));

  const subscriptionStates = await resolveSubscriptionStates(uniquePlans.map((p) => p.symbol));

  const entries: FocusReportEntry[] = uniquePlans.map((plan) => {
    const { breakdown, input, fromPersisted } = resolvePlanBreakdown(plan, opts, now);
    const tier = tierForTotal(breakdown.total);
    const catalystLabels = parseJsonArray(plan.catalysts);
    const createdAtMs = Date.parse(plan.createdAt);
    const total = breakdown.total;

    const whySelected = buildWhySelected(plan, input, breakdown);
    if (tier === 'REJECTED') {
      whySelected.unshift(
        `below WATCH cutoff (total ${total.toFixed(4)} < ${cfg.tierCutoffs.watch.toFixed(2)}; ` +
          `${breakdown.inputsMissing.length} inputs missing)`,
      );
    } else if (fromPersisted) {
      whySelected.push('score from persisted refresh breakdown');
    }

    return {
      symbol: plan.symbol,
      tier,
      total,
      components: breakdown.components,
      weights: breakdown.weights,
      inputsMissing: breakdown.inputsMissing,
      whySelected,
      catalyst: {
        labels: catalystLabels,
        type: plan.catalystType,
        sourceCount: plan.catalystSourceCount,
        scored: input.catalyst != null,
      },
      freshness: {
        planStatus: plan.status,
        validUntil: plan.validUntil,
        dataFresh: input.dataFresh,
        planAgeMinutes: Number.isFinite(createdAtMs)
          ? Math.max(0, Math.round((now.getTime() - createdAtMs) / 60000))
          : null,
      },
      strategyApplicability: input.strategyApplicability ?? [],
      dataReadiness: {
        available: breakdown.inputsAvailable,
        missing: breakdown.inputsMissing,
        completeness:
          breakdown.inputsAvailable.length + breakdown.inputsMissing.length > 0
            ? breakdown.inputsAvailable.length /
              (breakdown.inputsAvailable.length + breakdown.inputsMissing.length)
            : 0,
      },
      subscriptionState: subscriptionStates.get(plan.symbol) ?? 'UNKNOWN',
    };
  });

  const tiers = Object.fromEntries(TIERS.map((t) => [t, [] as FocusReportEntry[]])) as Record<
    FocusTier,
    FocusReportEntry[]
  >;
  for (const entry of entries) {
    const bucket = tiers[entry.tier];
    if (bucket.length < cfg.report.maxSymbolsPerTier) bucket.push(entry);
  }
  for (const t of TIERS) {
    tiers[t].sort((a, b) => b.total - a.total || (a.symbol < b.symbol ? -1 : 1));
  }

  const missingInputHistogram: Record<string, number> = {};
  for (const entry of entries) {
    for (const name of entry.inputsMissing) {
      missingInputHistogram[name] = (missingInputHistogram[name] ?? 0) + 1;
    }
  }
  const planStatuses: Record<string, number> = {};
  for (const plan of uniquePlans) {
    planStatuses[plan.status] = (planStatuses[plan.status] ?? 0) + 1;
  }

  const report: FocusReport = {
    tradingDate,
    refreshVersion,
    generatedAt: now.toISOString(),
    refreshedAt: opts.refreshedAt ?? null,
    tiers,
    metrics: {
      candidateCount: entries.length,
      scoredCount: entries.length,
      avgTotal: entries.length > 0 ? entries.reduce((s, e) => s + e.total, 0) / entries.length : 0,
      missingInputHistogram,
      refreshedAt: opts.refreshedAt ?? null,
    },
    sources: {
      plansRead: plans.length,
      symbolsScored: entries.length,
      planStatuses,
    },
  };

  // Persist (upsert on the (plan_date, refresh_version) unique index).
  const { db } = await import('../db');
  const { premarketFocusReports } = await import('../db/schema');
  const id = `premarket-focus-${tradingDate}-v${refreshVersion}`;
  const persistedAt = now.toISOString();
  await db
    .insert(premarketFocusReports)
    .values({
      id,
      planDate: tradingDate,
      generatedAt: report.generatedAt,
      refreshVersion,
      primaryJson: JSON.stringify(report.tiers.PRIMARY),
      secondaryJson: JSON.stringify(report.tiers.SECONDARY),
      watchJson: JSON.stringify(report.tiers.WATCH),
      rejectedJson: JSON.stringify(report.tiers.REJECTED),
      sourcesJson: JSON.stringify(report.sources),
      metricsJson: JSON.stringify(report.metrics),
      createdAt: persistedAt,
    })
    .onConflictDoUpdate({
      target: [premarketFocusReports.planDate, premarketFocusReports.refreshVersion],
      set: {
        generatedAt: report.generatedAt,
        primaryJson: JSON.stringify(report.tiers.PRIMARY),
        secondaryJson: JSON.stringify(report.tiers.SECONDARY),
        watchJson: JSON.stringify(report.tiers.WATCH),
        rejectedJson: JSON.stringify(report.tiers.REJECTED),
        sourcesJson: JSON.stringify(report.sources),
        metricsJson: JSON.stringify(report.metrics),
        createdAt: persistedAt,
      },
    });

  // Observability: one bounded PREMARKET_CANDIDATE_SCORED per candidate.
  // Each emission is isolated; a failure here never breaks the report.
  const { emitPremarketCandidateScored } = await import('./premarketFocusEvents');
  for (const entry of entries) {
    try {
      emitPremarketCandidateScored({
        symbol: entry.symbol,
        tradingDate,
        refreshVersion,
        tier: entry.tier,
        total: entry.total,
        components: { ...entry.components },
        weights: { ...entry.weights },
        inputsMissing: entry.inputsMissing,
        dataFresh: entry.freshness.dataFresh,
        scoredAt: report.generatedAt,
        topN: cfg.report.topContributionsKept,
        roundDecimals: cfg.report.roundDecimals,
      });
    } catch (e) {
      console.error(`[premarket-focus] candidate emission failed for ${entry.symbol} (isolated)`, e);
    }
  }

  return report;
}

/**
 * Read-only service function for the CLI (`argus premarket-focus`) and any
 * other read path. Returns the latest persisted report for a trading date
 * (or the specific refreshVersion), or null when none exists. No heavy logic:
 * parse the persisted row and return it.
 */
export async function getPersistedFocusReport(
  tradingDate: string,
  refreshVersion?: number,
): Promise<FocusReport | null> {
  const { db } = await import('../db');
  const { premarketFocusReports } = await import('../db/schema');
  const { eq, and, desc } = await import('drizzle-orm');

  const rows = await db
    .select()
    .from(premarketFocusReports)
    .where(
      refreshVersion != null
        ? and(eq(premarketFocusReports.planDate, tradingDate), eq(premarketFocusReports.refreshVersion, refreshVersion))
        : eq(premarketFocusReports.planDate, tradingDate),
    )
    .orderBy(desc(premarketFocusReports.refreshVersion))
    .limit(1);
  if (rows.length === 0) return null;
  const row = rows[0];

  const parseTier = (json: string): FocusReportEntry[] => {
    try {
      const parsed: unknown = JSON.parse(json);
      return Array.isArray(parsed) ? (parsed as FocusReportEntry[]) : [];
    } catch {
      return [];
    }
  };
  let metrics: FocusReportMetrics;
  try {
    metrics = row.metricsJson ? (JSON.parse(row.metricsJson) as FocusReportMetrics) : ({} as FocusReportMetrics);
  } catch {
    metrics = {} as FocusReportMetrics;
  }

  return {
    tradingDate: row.planDate,
    refreshVersion: row.refreshVersion,
    generatedAt: row.generatedAt,
    refreshedAt: metrics.refreshedAt ?? null,
    tiers: {
      PRIMARY: parseTier(row.primaryJson),
      SECONDARY: parseTier(row.secondaryJson),
      WATCH: parseTier(row.watchJson),
      REJECTED: parseTier(row.rejectedJson),
    },
    metrics: {
      candidateCount: metrics.candidateCount ?? 0,
      scoredCount: metrics.scoredCount ?? 0,
      avgTotal: metrics.avgTotal ?? 0,
      missingInputHistogram: metrics.missingInputHistogram ?? {},
      refreshedAt: metrics.refreshedAt ?? null,
    },
    sources: (() => {
      try {
        return JSON.parse(row.sourcesJson) as FocusReportSources;
      } catch {
        return { plansRead: 0, symbolsScored: 0, planStatuses: {} };
      }
    })(),
  };
}
/**
 * Workstream B's pre-market lifecycle status contract (2026-10-06 course
 * correction). Canonical definition lives alongside getPremarketLifecycleStatus()
 * in ../continuous/TradePlanBuilder ("Workstream D CLI contract — shape is
 * stable, do not change without coordinating"); imported here as the single
 * source of truth. The runtime validator below still guards against shape
 * drift (the CLI must degrade gracefully, never throw).
 */
import type { PremarketLifecycleStatus } from '../continuous/TradePlanBuilder';
export type { PremarketLifecycleStatus };

const NEXT_REFRESH_KINDS = ['MID_MORNING', 'LATE_REFRESH', 'PREOPEN_VALIDATION', 'EVENT_DRIVEN'];
const PLAN_COUNT_KEYS = ['PRIMARY', 'BACKUP', 'WATCH', 'DOWNGRADED', 'EXPIRED'];

function isValidLifecycleStatus(raw: unknown): raw is PremarketLifecycleStatus {
  if (raw == null || typeof raw !== 'object') return false;
  const s = raw as Record<string, unknown>;
  const pc = s.planCounts as Record<string, unknown> | undefined;
  return (
    typeof s.tradingDate === 'string' &&
    typeof s.sessionPhase === 'string' &&
    (s.lastBuildAt === null || typeof s.lastBuildAt === 'string') &&
    typeof s.lastBuildVersion === 'number' &&
    Number.isInteger(s.lastBuildVersion) &&
    (s.evidenceAsof === null || typeof s.evidenceAsof === 'string') &&
    (s.nextRefreshAt === null || typeof s.nextRefreshAt === 'string') &&
    (s.nextRefreshKind === null ||
      (typeof s.nextRefreshKind === 'string' && NEXT_REFRESH_KINDS.includes(s.nextRefreshKind))) &&
    pc != null &&
    typeof pc === 'object' &&
    PLAN_COUNT_KEYS.every((k) => typeof pc[k] === 'number') &&
    (s.oldestPlanAgeMinutes === null || typeof s.oldestPlanAgeMinutes === 'number') &&
    typeof s.refreshDue === 'boolean'
  );
}

/**
 * Best-effort read of workstream B's getPremarketLifecycleStatus(). Never
 * throws: returns null when B hasn't landed the function yet, the import
 * fails, or the shape drifted — callers (CLI) degrade gracefully. The parent
 * reconciles the contract at integration.
 */
export async function getPremarketLifecycleStatusSafe(
  tradingDate?: string,
): Promise<PremarketLifecycleStatus | null> {
  try {
    const mod = (await import('../continuous/TradePlanBuilder')) as unknown as Record<string, unknown>;
    const fn = mod.getPremarketLifecycleStatus;
    if (typeof fn !== 'function') return null;
    const raw = await (fn as (tradingDate?: string) => Promise<unknown>)(tradingDate);
    return isValidLifecycleStatus(raw) ? raw : null;
  } catch {
    return null;
  }
}

export type PlanTierMovementKind = 'PROMOTED' | 'DOWNGRADED' | 'EXPIRED';

export interface PlanTierMovement {
  symbol: string;
  kind: PlanTierMovementKind;
  /** Previous setupType (or previous status context for EXPIRED). */
  from: string | null;
  /** Current setupType; null when the plan vanished between builds. */
  to: string | null;
}

/** Lifecycle tier rank for promotion/downgrade comparison (lower = higher tier). */
const SETUP_TIER_RANK: Record<string, number> = { PRIMARY: 0, BACKUP: 1, WATCHLIST: 2 };

/**
 * Promotions / downgrades / expiries "since the previous build": compares the
 * two latest refresh versions of the trade plans for a trading date. A symbol
 * whose latest plan is EXPIRED (or which vanished between versions) counts as
 * EXPIRED. Returns empty movements when fewer than two versions exist.
 */
export async function getPlanTierMovements(tradingDate: string): Promise<{
  currentVersion: number | null;
  previousVersion: number | null;
  movements: PlanTierMovement[];
}> {
  const { getTradePlansForDate } = await import('../continuous/TradePlanBuilder');
  const plans = (await getTradePlansForDate(tradingDate)).filter((p) => p.planDate === tradingDate);
  const versions = [...new Set(plans.map((p) => p.refreshVersion))].sort((a, b) => a - b);
  if (versions.length < 2) {
    return { currentVersion: versions[0] ?? null, previousVersion: null, movements: [] };
  }
  const currentVersion = versions[versions.length - 1];
  const previousVersion = versions[versions.length - 2];
  // Latest row wins per (version, symbol); getTradePlansForDate orders by
  // rankAtCreation, so the Map keeps the last row per symbol per version.
  const current = new Map(
    plans.filter((p) => p.refreshVersion === currentVersion).map((p) => [p.symbol, p] as const),
  );
  const previous = new Map(
    plans.filter((p) => p.refreshVersion === previousVersion).map((p) => [p.symbol, p] as const),
  );
  const movements: PlanTierMovement[] = [];
  for (const [symbol, prev] of previous) {
    const cur = current.get(symbol);
    if (!cur || (cur.status === 'EXPIRED' && prev.status !== 'EXPIRED')) {
      movements.push({ symbol, kind: 'EXPIRED', from: prev.setupType, to: cur?.setupType ?? null });
      continue;
    }
    const prevRank = SETUP_TIER_RANK[prev.setupType] ?? 99;
    const curRank = SETUP_TIER_RANK[cur.setupType] ?? 99;
    if (curRank < prevRank) {
      movements.push({ symbol, kind: 'PROMOTED', from: prev.setupType, to: cur.setupType });
    } else if (curRank > prevRank) {
      movements.push({ symbol, kind: 'DOWNGRADED', from: prev.setupType, to: cur.setupType });
    }
  }
  movements.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { currentVersion, previousVersion, movements };
}

export interface FocusCliPlanEntry {
  symbol: string;
  /** Lifecycle tier: PRIMARY | BACKUP | WATCHLIST (as stored on the plan). */
  setupType: string;
  /** The plan's recorded direction — displayed as descriptive plan data with
   *  the "never trade this" disclaimer, never as a recommendation. */
  direction: string;
  /** Decomposed pre-market opportunity score total (0..1). */
  total: number;
  /** Score-based attention tier (PRIMARY/SECONDARY/WATCH/REJECTED). */
  attentionTier: FocusTier;
  catalystLabels: string[];
  catalystType: string | null;
  dataAvailable: number;
  dataTotal: number;
  dataMissing: string[];
  planAgeMinutes: number | null;
  planVersion: number;
  refreshReason: string | null;
  refreshedAt: string | null;
  whySelected: string[];
}

export interface PremarketFocusCliView {
  tradingDate: string;
  generatedAt: string;
  /** Null when workstream B's status function is unavailable or drifted. */
  lifecycle: PremarketLifecycleStatus | null;
  /** Latest refresh version per symbol, lifecycle-tier sorted. */
  plans: FocusCliPlanEntry[];
  movements: PlanTierMovement[];
  movementVersions: { current: number | null; previous: number | null };
  /** Persisted score-based attention-tier report, if one exists for the date. */
  focusReport: FocusReport | null;
}

/** Latest refresh version wins per symbol (tie: latest createdAt). */
function dedupePlansLatestVersion(plans: TradePlanRow[]): TradePlanRow[] {
  const bySymbol = new Map<string, TradePlanRow>();
  for (const plan of plans) {
    const prev = bySymbol.get(plan.symbol);
    if (
      !prev ||
      plan.refreshVersion > prev.refreshVersion ||
      (plan.refreshVersion === prev.refreshVersion && plan.createdAt > prev.createdAt)
    ) {
      bySymbol.set(plan.symbol, plan);
    }
  }
  return [...bySymbol.values()];
}

/**
 * Read-only service function for `argus premarket-focus`: assembles the full
 * CLI view — lifecycle status (best-effort), per-symbol plan rows enriched
 * with score decompositions, tier movements since the previous build, and the
 * persisted focus report. No heavy logic in the CLI itself; this function
 * owns the DB reads. Never throws for a missing lifecycle status (null), but
 * DB failures propagate to the caller (the CLI reports them).
 */
export async function getPremarketFocusCliView(
  tradingDate: string,
  now: Date = new Date(),
): Promise<PremarketFocusCliView> {
  const { getTradePlansForDate } = await import('../continuous/TradePlanBuilder');
  const plans = dedupePlansLatestVersion(
    (await getTradePlansForDate(tradingDate)).filter((p) => p.planDate === tradingDate),
  );

  const [lifecycle, movementInfo, focusReport] = await Promise.all([
    getPremarketLifecycleStatusSafe(tradingDate),
    getPlanTierMovements(tradingDate),
    getPersistedFocusReport(tradingDate),
  ]);

  const entries: FocusCliPlanEntry[] = plans.map((plan) => {
    const { breakdown, input } = resolvePlanBreakdown(plan, {}, now);
    const createdMs = Date.parse(plan.originalCreatedAt ?? plan.createdAt);
    return {
      symbol: plan.symbol,
      setupType: plan.setupType,
      direction: plan.direction,
      total: breakdown.total,
      attentionTier: tierForTotal(breakdown.total),
      catalystLabels: parseJsonArray(plan.catalysts),
      catalystType: plan.catalystType,
      dataAvailable: breakdown.inputsAvailable.length,
      dataTotal: breakdown.inputsAvailable.length + breakdown.inputsMissing.length,
      dataMissing: breakdown.inputsMissing,
      planAgeMinutes: Number.isFinite(createdMs)
        ? Math.max(0, Math.round((now.getTime() - createdMs) / 60000))
        : null,
      planVersion: plan.refreshVersion,
      refreshReason: plan.reasonForRefresh,
      refreshedAt: plan.refreshedAt,
      whySelected: buildWhySelected(plan, input, breakdown),
    };
  });
  entries.sort(
    (a, b) =>
      (SETUP_TIER_RANK[a.setupType] ?? 99) - (SETUP_TIER_RANK[b.setupType] ?? 99) || b.total - a.total,
  );

  return {
    tradingDate,
    generatedAt: now.toISOString(),
    lifecycle,
    plans: entries,
    movements: movementInfo.movements,
    movementVersions: { current: movementInfo.currentVersion, previous: movementInfo.previousVersion },
    focusReport,
  };
}
