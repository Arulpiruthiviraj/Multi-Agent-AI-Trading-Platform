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

function resolveBreakdown(
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
    const { breakdown, input, fromPersisted } = resolveBreakdown(plan, opts, now);
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
