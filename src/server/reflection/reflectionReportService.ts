/**
 * Daily reflection report builder (2026-10-06, workstream J, local-only).
 *
 * Assembles the post-market reflection report for one trading date from the
 * already-persisted reflection evidence tables. READ-ONLY: this module only
 * runs SELECTs (plus a sqlite_master existence check so it fails soft when
 * the producer tables have not landed yet). It never writes, never touches
 * ChiefTrader / RiskEngine / OMS / BrokerManager, and never carries a
 * direction/side — the report explains what happened, never what to trade.
 *
 * Producer/consumer contract (workstreams H and I own the producers):
 *   - `mover_coverage` (workstream H): one row per (trading_date, symbol) for
 *     every end-of-day market mover, with Argus's fate for that symbol.
 *     Columns consumed: trading_date, symbol, eod_move_pct, primary_fate,
 *     secondary_reasons (JSON array of strings), never_seen_cause,
 *     reference_price, outcome_windows (JSON array of {window, returnPct}),
 *     filter_reason, filter_premise_correct, premarket_known_by (JSON array).
 *   - `reflection_session_metrics` (workstream I): one row per trading date
 *     with session-level funnel counts and repeating-issue notes.
 *   - `premarket_focus_reports` (workstream D, exists): latest focus report.
 *   - `postmarket_reports` (exists): session-level classifications/findings.
 *
 * Because H/I may not have landed yet, every producer table is read
 * defensively: missing table -> empty section with an honest note in
 * `sources`. The report never fabricates a mover, a fate, or a number.
 *
 * primary_fate taxonomy (workstream H, exact — see drizzle/0093_mover_coverage.sql):
 *   ACTED_ON                mover was acted on (evaluated + entered)
 *   APPROVED_NOT_EXECUTED   approved but not executed (evaluated, no action)
 *   CONSENSUS_REJECTED       evaluated, consensus did not clear
 *   RISK_REJECTED            evaluated, RiskEngine rejected
 *   STRATEGY_NO_SETUP        evaluated, no strategy setup found
 *   EVALUATED                evaluated, no action recorded
 *   SUBSCRIBED_NOT_EVALUATED seen (subscribed) but never evaluated
 *   DISCOVERED_FILTERED      filtered at discovery (see filter_reason)
 *   DISCOVERED_NOT_PROMOTED  discovered but not promoted to evaluation
 *   NEVER_SEEN               mover never entered Argus's field of view
 *   INSUFFICIENT_EVIDENCE    dropped for insufficient evidence / data readiness
 * never_seen_cause is one of: UNIVERSE_COVERAGE | NEWS_SOURCE_COVERAGE |
 * MARKET_MOVER_SOURCE | RANK_CAP | DATA_UNAVAILABLE | SYMBOL_EXTRACTION |
 * PREMARKET_REFRESH_TIMING | OTHER | UNKNOWN (UNKNOWN is honest, never invented).
 *
 * Funnel semantics: seen = fate != NEVER_SEEN/UNKNOWN; evaluated =
 * ACTED_ON|APPROVED_NOT_EXECUTED|CONSENSUS_REJECTED|RISK_REJECTED|
 * STRATEGY_NO_SETUP|EVALUATED; acted = ACTED_ON. "Filtered" = DISCOVERED_FILTERED
 * fate or a non-null filter_reason. Data-readiness = INSUFFICIENT_EVIDENCE fate.
 * The CONSENSUS/RISK/DATA rejection sections take the primary fate first and
 * fall back to secondary-reason text only when the reason mentions the topic
 * AND carries rejection vocabulary (reject/held/fail/gate/...) — a bare
 * topic mention such as "CONSENSUS: 0.81 > 0.75" (a pass note) never counts.
 *
 * "Filtered winners-losers" is filter-centric, not threshold-invented: a
 * filtered mover is a "filtered winner" when filter_premise_correct=false
 * (the filter kept us out of a mover that won anyway) and a "filtered loser"
 * when filter_premise_correct=true (the filter correctly avoided it).
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type MoverFate =
  | 'ACTED_ON'
  | 'APPROVED_NOT_EXECUTED'
  | 'CONSENSUS_REJECTED'
  | 'RISK_REJECTED'
  | 'STRATEGY_NO_SETUP'
  | 'EVALUATED'
  | 'SUBSCRIBED_NOT_EVALUATED'
  | 'DISCOVERED_FILTERED'
  | 'DISCOVERED_NOT_PROMOTED'
  | 'NEVER_SEEN'
  | 'INSUFFICIENT_EVIDENCE'
  | 'UNKNOWN';

const KNOWN_FATES: ReadonlySet<string> = new Set([
  'ACTED_ON',
  'APPROVED_NOT_EXECUTED',
  'CONSENSUS_REJECTED',
  'RISK_REJECTED',
  'STRATEGY_NO_SETUP',
  'EVALUATED',
  'SUBSCRIBED_NOT_EVALUATED',
  'DISCOVERED_FILTERED',
  'DISCOVERED_NOT_PROMOTED',
  'NEVER_SEEN',
  'INSUFFICIENT_EVIDENCE',
]);

export interface OutcomeWindow {
  window: string;
  returnPct: number | null;
  note?: string;
}

export interface MoverCoverageRow {
  tradingDate: string;
  symbol: string;
  eodMovePct: number | null;
  primaryFate: MoverFate;
  secondaryReasons: string[];
  neverSeenCause: string | null;
  referencePrice: number | null;
  outcomeWindows: OutcomeWindow[];
  filterReason: string | null;
  filterPremiseCorrect: boolean | null;
  premarketKnownBy: string[];
}

/**
 * Workstream I's reflection_session_metrics (see drizzle/0094_reflection_metrics.sql):
 * one row per trading date; rate fields are 0..1 proportions or null.
 */
export interface ReflectionSessionMetrics {
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
}

// ---- Report sections -----------------------------------------------------

export interface MoverSummary {
  symbol: string;
  eodMovePct: number | null;
  primaryFate: MoverFate;
  filterReason: string | null;
  filterPremiseCorrect: boolean | null;
  neverSeenCause: string | null;
}

export interface FunnelCounts {
  movers: number;
  seen: number;
  evaluated: number;
  acted: number;
}

export interface DiscoveryCoverageSection {
  funnel: FunnelCounts;
  fateHistogram: Record<string, number>;
  /** Independent mover/seen counts from reflection_session_metrics, when present. */
  sessionMetricsCheck: { moversTotal: number; moversSeen: number } | null;
  /** The workstream-I rate scorecard (0..1 proportions), nulls where unwritten. */
  sessionMetricsRates: {
    focusRecall: number | null;
    primaryDataReadiness: number | null;
    catalystCoverage: number | null;
    neverSeenRate: number | null;
    discoveryFilterRate: number | null;
    evaluationRate: number | null;
    validTriggerRate: number | null;
    consensusApprovalRate: number | null;
    primaryPrecision: number | null;
  } | null;
}

export interface FocusPerformanceSection {
  refreshVersion: number;
  generatedAt: string;
  candidateCount: number;
  scoredCount: number;
  avgTotal: number;
  tierCounts: Record<'PRIMARY' | 'SECONDARY' | 'WATCH' | 'REJECTED', number>;
  missingInputHistogram: Record<string, number>;
}

export interface NeverSeenMover {
  symbol: string;
  eodMovePct: number | null;
  cause: string | null;
  referencePrice: number | null;
}

export interface FilteredMover {
  symbol: string;
  eodMovePct: number | null;
  filterReason: string | null;
  premiseCorrect: boolean | null;
  /** 'winner' = premise wrong (filter kept us out of a mover); 'loser' = premise held. */
  premiseLabel: 'winner' | 'loser' | 'unevaluated';
}

export interface FilteredWinnersLosersSection {
  filteredCount: number;
  premiseHeld: number;
  premiseWrong: number;
  premiseUnevaluated: number;
  movers: FilteredMover[];
}

export interface RejectedMover {
  symbol: string;
  eodMovePct: number | null;
  reasons: string[];
}

export interface DataReadinessSection {
  movers: RejectedMover[];
  /** Data inputs the pre-market focus report was missing, by input name. */
  focusMissingInputs: Record<string, number>;
  /** Workstream-I primary_data_readiness rate (0..1), when recorded. */
  sessionMetricsPrimaryDataReadiness: number | null;
}

export interface CatalystCoverageSection {
  withCatalyst: number;
  withoutCatalyst: number;
  withCatalystSymbols: string[];
  withoutCatalystSymbols: string[];
}

export interface PostmarketSummary {
  status: string;
  generatedAt: string;
  totalSymbolsTouched: number;
  byClassification: Record<string, number>;
  findings: Array<{ title?: string; detail?: string }>;
}

export interface ReportSources {
  moverCoverageRows: number;
  moverCoverageTablePresent: boolean;
  sessionMetrics: boolean;
  premarketFocus: boolean;
  postmarket: boolean;
}

export interface DailyReflectionReport {
  tradingDate: string;
  generatedAt: string;
  /** False when every source is absent/empty — surfaces must say so honestly. */
  hasData: boolean;
  sources: ReportSources;
  premarketFocusPerformance: FocusPerformanceSection | null;
  discoveryCoverage: DiscoveryCoverageSection;
  neverSeenMovers: NeverSeenMover[];
  filteredWinnersLosers: FilteredWinnersLosersSection;
  consensusRejections: RejectedMover[];
  riskRejections: RejectedMover[];
  dataReadinessFailures: DataReadinessSection;
  catalystCoverage: CatalystCoverageSection;
  repeatingIssues: string[];
  postmarketSummary: PostmarketSummary | null;
  /** Full per-symbol list (sorted by |eod_move_pct| desc) for drill-down. */
  movers: MoverSummary[];
  /** Per-symbol evidence for drill-down (bounded: one entry per mover). */
  moverDetails: Record<string, MoverDetail>;
}

export interface MoverDetail {
  symbol: string;
  eodMovePct: number | null;
  primaryFate: MoverFate;
  secondaryReasons: string[];
  neverSeenCause: string | null;
  referencePrice: number | null;
  outcomeWindows: OutcomeWindow[];
  filterReason: string | null;
  filterPremiseCorrect: boolean | null;
  premarketKnownBy: string[];
}

export interface BuildDailyReflectionOptions {
  /** Fixture injection for tests; default: load from mover_coverage. */
  movers?: MoverCoverageRow[];
  /** Fixture injection for tests; default: load from reflection_session_metrics. */
  sessionMetrics?: ReflectionSessionMetrics | null;
  now?: Date;
}

// ---- Defensive parsing ---------------------------------------------------

function parseJsonStringArray(value: unknown): string[] {
  if (value == null) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function parseOutcomeWindows(value: unknown): OutcomeWindow[] {
  if (value == null) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((w) => w != null && typeof w === 'object')
      .map((w) => {
        const o = w as Record<string, unknown>;
        const returnPct = typeof o.returnPct === 'number' ? o.returnPct : typeof o.return_pct === 'number' ? o.return_pct : null;
        return {
          window: typeof o.window === 'string' ? o.window : '?',
          returnPct,
          note: typeof o.note === 'string' ? o.note : undefined,
        };
      });
  } catch {
    return [];
  }
}

function normalizeFate(raw: unknown): MoverFate {
  const f = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  return KNOWN_FATES.has(f) ? (f as MoverFate) : 'UNKNOWN';
}

function toNumberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function parseMoverCoverageRow(raw: Record<string, unknown>): MoverCoverageRow {
  return {
    tradingDate: typeof raw.trading_date === 'string' ? raw.trading_date : '',
    symbol: typeof raw.symbol === 'string' ? raw.symbol : '?',
    eodMovePct: toNumberOrNull(raw.eod_move_pct),
    primaryFate: normalizeFate(raw.primary_fate),
    secondaryReasons: parseJsonStringArray(raw.secondary_reasons),
    neverSeenCause: typeof raw.never_seen_cause === 'string' ? raw.never_seen_cause : null,
    referencePrice: toNumberOrNull(raw.reference_price),
    outcomeWindows: parseOutcomeWindows(raw.outcome_windows),
    filterReason: typeof raw.filter_reason === 'string' ? raw.filter_reason : null,
    filterPremiseCorrect:
      raw.filter_premise_correct === 1 || raw.filter_premise_correct === true
        ? true
        : raw.filter_premise_correct === 0 || raw.filter_premise_correct === false
          ? false
          : null,
    premarketKnownBy: parseJsonStringArray(raw.premarket_known_by),
  };
}

function parseSessionMetricsRow(raw: Record<string, unknown>): ReflectionSessionMetrics {
  const rate = (v: unknown): number | null => {
    const n = toNumberOrNull(v);
    return n == null ? null : n;
  };
  return {
    tradingDate: typeof raw.trading_date === 'string' ? raw.trading_date : '',
    moversTotal: toNumberOrNull(raw.movers_total),
    moversSeen: toNumberOrNull(raw.movers_seen),
    focusRecall: rate(raw.focus_recall),
    primaryDataReadiness: rate(raw.primary_data_readiness),
    catalystCoverage: rate(raw.catalyst_coverage),
    neverSeenRate: rate(raw.never_seen_rate),
    discoveryFilterRate: rate(raw.discovery_filter_rate),
    evaluationRate: rate(raw.evaluation_rate),
    validTriggerRate: rate(raw.valid_trigger_rate),
    consensusApprovalRate: rate(raw.consensus_approval_rate),
    primaryPrecision: rate(raw.primary_precision),
  };
}

// ---- Read-only data access ------------------------------------------------

async function tableExists(name: string): Promise<boolean> {
  const { sqliteDb } = await import('../db');
  const row = sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
    | { name: string }
    | undefined;
  return row != null;
}

async function loadMoverCoverage(tradingDate: string): Promise<{ rows: MoverCoverageRow[]; tablePresent: boolean }> {
  const present = await tableExists('mover_coverage');
  if (!present) return { rows: [], tablePresent: false };
  const { sqliteDb } = await import('../db');
  const raw = sqliteDb
    .prepare('SELECT * FROM mover_coverage WHERE trading_date = ? ORDER BY ABS(eod_move_pct) DESC')
    .all(tradingDate) as Record<string, unknown>[];
  return { rows: raw.map(parseMoverCoverageRow), tablePresent: true };
}

async function loadSessionMetrics(tradingDate: string): Promise<ReflectionSessionMetrics | null> {
  if (!(await tableExists('reflection_session_metrics'))) return null;
  const { sqliteDb } = await import('../db');
  const raw = sqliteDb
    .prepare('SELECT * FROM reflection_session_metrics WHERE trading_date = ? ORDER BY rowid DESC LIMIT 1')
    .get(tradingDate) as Record<string, unknown> | undefined;
  return raw ? parseSessionMetricsRow(raw) : null;
}

async function loadFocusPerformance(tradingDate: string): Promise<FocusPerformanceSection | null> {
  const { getPersistedFocusReport } = await import('../premarket/PremarketFocusReport');
  const fr = await getPersistedFocusReport(tradingDate);
  if (!fr) return null;
  return {
    refreshVersion: fr.refreshVersion,
    generatedAt: fr.generatedAt,
    candidateCount: fr.metrics.candidateCount ?? 0,
    scoredCount: fr.metrics.scoredCount ?? 0,
    avgTotal: fr.metrics.avgTotal ?? 0,
    tierCounts: {
      PRIMARY: fr.tiers.PRIMARY.length,
      SECONDARY: fr.tiers.SECONDARY.length,
      WATCH: fr.tiers.WATCH.length,
      REJECTED: fr.tiers.REJECTED.length,
    },
    missingInputHistogram: fr.metrics.missingInputHistogram ?? {},
  };
}

async function loadPostmarketSummary(tradingDate: string): Promise<PostmarketSummary | null> {
  const { db } = await import('../db');
  const { postmarketReports } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');
  const rows = await db.select().from(postmarketReports).where(eq(postmarketReports.tradingDate, tradingDate)).limit(1);
  if (rows.length === 0) return null;
  const row = rows[0];
  let byClassification: Record<string, number> = {};
  try {
    const parsed: unknown = JSON.parse(row.byClassificationJson);
    if (parsed != null && typeof parsed === 'object') byClassification = parsed as Record<string, number>;
  } catch {
    byClassification = {};
  }
  let findings: Array<{ title?: string; detail?: string }> = [];
  try {
    const parsed: unknown = JSON.parse(row.findingsJson);
    if (Array.isArray(parsed)) findings = parsed as Array<{ title?: string; detail?: string }>;
  } catch {
    findings = [];
  }
  return {
    status: row.status,
    generatedAt: row.generatedAt,
    totalSymbolsTouched: row.totalSymbolsTouched,
    byClassification,
    findings,
  };
}

/**
 * Most recent completed session: the latest trading date with a COMPLETED
 * post-market report, falling back to mover_coverage, then pre-market focus,
 * then yesterday. "Completed" is keyed off the post-market report because
 * that is the session-closing artifact.
 */
export async function getMostRecentCompletedTradingDate(): Promise<string> {
  const { sqliteDb } = await import('../db');
  const scalar = (sql: string): string | null => {
    try {
      const row = sqliteDb.prepare(sql).get() as { d: string | null } | undefined;
      return row?.d ?? null;
    } catch {
      return null;
    }
  };
  const completed = scalar("SELECT MAX(trading_date) AS d FROM postmarket_reports WHERE status = 'COMPLETED'");
  if (completed) return completed;
  if (await tableExists('mover_coverage')) {
    const mc = scalar('SELECT MAX(trading_date) AS d FROM mover_coverage');
    if (mc) return mc;
  }
  const pf = scalar('SELECT MAX(plan_date) AS d FROM premarket_focus_reports');
  if (pf) return pf;
  const y = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return y.toISOString().slice(0, 10);
}

// ---- Section assembly (pure) ----------------------------------------------

const EVALUATED_FATES: ReadonlySet<MoverFate> = new Set([
  'ACTED_ON',
  'APPROVED_NOT_EXECUTED',
  'CONSENSUS_REJECTED',
  'RISK_REJECTED',
  'STRATEGY_NO_SETUP',
  'EVALUATED',
]);

function funnelFromMovers(movers: MoverCoverageRow[]): FunnelCounts {
  const seen = movers.filter((m) => m.primaryFate !== 'NEVER_SEEN' && m.primaryFate !== 'UNKNOWN').length;
  const evaluated = movers.filter((m) => EVALUATED_FATES.has(m.primaryFate)).length;
  const acted = movers.filter((m) => m.primaryFate === 'ACTED_ON').length;
  return { movers: movers.length, seen, evaluated, acted };
}

/**
 * A secondary reason only lands a mover in a rejection section when it both
 * mentions the topic AND carries rejection vocabulary — a bare topic mention
 * (e.g. "CONSENSUS: 0.81 > 0.75", a pass note) must not count as a rejection.
 */
const REJECTION_VOCAB: Record<'consensus' | 'risk' | 'data', RegExp> = {
  consensus: /reject|held|no[_\s-]?consensus|fail|below|did not clear|blocked|veto/i,
  risk: /reject|fail|gate|blocked|veto|breach/i,
  data: /not ready|no fresh|missing|unavailable|stale|fail|no data/i,
};

function rejectedFor(reasons: string[], topic: 'consensus' | 'risk' | 'data'): boolean {
  const joined = reasons.join(' ');
  return joined.toLowerCase().includes(topic) && REJECTION_VOCAB[topic].test(joined);
}

function hasCatalystEvidence(m: MoverCoverageRow): boolean {
  if (m.premarketKnownBy.some((k) => k.toLowerCase().includes('catalyst'))) return true;
  return m.secondaryReasons.some((r) => r.trim().toUpperCase().startsWith('CATALYST'));
}

function byAbsMoveDesc(a: MoverSummary, b: MoverSummary): number {
  return Math.abs(b.eodMovePct ?? 0) - Math.abs(a.eodMovePct ?? 0);
}

/**
 * Pure assembly from already-loaded rows. The async wrapper below adds the
 * DB reads; tests exercise this function with fixtures only.
 */
export function assembleReflectionSections(
  tradingDate: string,
  movers: MoverCoverageRow[],
  sessionMetrics: ReflectionSessionMetrics | null,
  focus: FocusPerformanceSection | null,
  postmarket: PostmarketSummary | null,
  moverCoverageTablePresent: boolean,
  now: Date,
): DailyReflectionReport {
  const sorted = [...movers].sort((a, b) => Math.abs(b.eodMovePct ?? 0) - Math.abs(a.eodMovePct ?? 0));
  const summaries: MoverSummary[] = sorted.map((m) => ({
    symbol: m.symbol,
    eodMovePct: m.eodMovePct,
    primaryFate: m.primaryFate,
    filterReason: m.filterReason,
    filterPremiseCorrect: m.filterPremiseCorrect,
    neverSeenCause: m.neverSeenCause,
  }));

  const fateHistogram: Record<string, number> = {};
  for (const m of movers) fateHistogram[m.primaryFate] = (fateHistogram[m.primaryFate] ?? 0) + 1;

  const funnel = funnelFromMovers(movers);
  const sessionMetricsCheck =
    sessionMetrics && (sessionMetrics.moversTotal != null || sessionMetrics.moversSeen != null)
      ? {
          moversTotal: sessionMetrics.moversTotal ?? 0,
          moversSeen: sessionMetrics.moversSeen ?? 0,
        }
      : null;
  const sessionMetricsRates =
    sessionMetrics != null
      ? {
          focusRecall: sessionMetrics.focusRecall,
          primaryDataReadiness: sessionMetrics.primaryDataReadiness,
          catalystCoverage: sessionMetrics.catalystCoverage,
          neverSeenRate: sessionMetrics.neverSeenRate,
          discoveryFilterRate: sessionMetrics.discoveryFilterRate,
          evaluationRate: sessionMetrics.evaluationRate,
          validTriggerRate: sessionMetrics.validTriggerRate,
          consensusApprovalRate: sessionMetrics.consensusApprovalRate,
          primaryPrecision: sessionMetrics.primaryPrecision,
        }
      : null;

  const neverSeenMovers: NeverSeenMover[] = sorted
    .filter((m) => m.primaryFate === 'NEVER_SEEN')
    .map((m) => ({
      symbol: m.symbol,
      eodMovePct: m.eodMovePct,
      cause: m.neverSeenCause,
      referencePrice: m.referencePrice,
    }));

  const filteredRows = sorted.filter((m) => m.primaryFate === 'DISCOVERED_FILTERED' || m.filterReason != null);
  const filteredMovers: FilteredMover[] = filteredRows.map((m) => ({
    symbol: m.symbol,
    eodMovePct: m.eodMovePct,
    filterReason: m.filterReason,
    premiseCorrect: m.filterPremiseCorrect,
    premiseLabel: m.filterPremiseCorrect === false ? 'winner' : m.filterPremiseCorrect === true ? 'loser' : 'unevaluated',
  }));
  const filteredWinnersLosers: FilteredWinnersLosersSection = {
    filteredCount: filteredRows.length,
    premiseHeld: filteredRows.filter((m) => m.filterPremiseCorrect === true).length,
    premiseWrong: filteredRows.filter((m) => m.filterPremiseCorrect === false).length,
    premiseUnevaluated: filteredRows.filter((m) => m.filterPremiseCorrect == null).length,
    movers: filteredMovers,
  };

  const toRejected = (m: MoverCoverageRow): RejectedMover => ({
    symbol: m.symbol,
    eodMovePct: m.eodMovePct,
    reasons: m.secondaryReasons,
  });
  const consensusRejections = sorted
    .filter((m) => m.primaryFate === 'CONSENSUS_REJECTED' || rejectedFor(m.secondaryReasons, 'consensus'))
    .map(toRejected);
  const riskRejections = sorted
    .filter((m) => m.primaryFate === 'RISK_REJECTED' || rejectedFor(m.secondaryReasons, 'risk'))
    .map(toRejected);

  const dataNotReadyMovers = sorted
    .filter((m) => m.primaryFate === 'INSUFFICIENT_EVIDENCE' || rejectedFor(m.secondaryReasons, 'data'))
    .map(toRejected);
  const dataReadinessFailures: DataReadinessSection = {
    movers: dataNotReadyMovers,
    focusMissingInputs: focus?.missingInputHistogram ?? {},
    sessionMetricsPrimaryDataReadiness: sessionMetrics?.primaryDataReadiness ?? null,
  };

  const withCatalyst = sorted.filter(hasCatalystEvidence);
  const withoutCatalyst = sorted.filter((m) => !hasCatalystEvidence(m));
  const catalystCoverage: CatalystCoverageSection = {
    withCatalyst: withCatalyst.length,
    withoutCatalyst: withoutCatalyst.length,
    withCatalystSymbols: withCatalyst.map((m) => m.symbol),
    withoutCatalystSymbols: withoutCatalyst.map((m) => m.symbol),
  };

  // Repeating issues: derived observed patterns only (the workstream-I
  // metrics table carries rates, not issue text — never invent issue text).
  const repeatingIssues: string[] = [];
  const causeCounts: Record<string, number> = {};
  for (const m of neverSeenMovers) {
    const cause = m.cause ?? 'cause not recorded';
    causeCounts[cause] = (causeCounts[cause] ?? 0) + 1;
  }
  for (const [cause, count] of Object.entries(causeCounts)) {
    if (count >= 2) {
      repeatingIssues.push(`[observed pattern] never-seen cause "${cause}" hit ${count} movers`);
    }
  }

  const hasData =
    movers.length > 0 ||
    sessionMetrics != null ||
    focus != null ||
    postmarket != null;

  const moverDetails: Record<string, MoverDetail> = {};
  for (const m of sorted) {
    moverDetails[m.symbol] = {
      symbol: m.symbol,
      eodMovePct: m.eodMovePct,
      primaryFate: m.primaryFate,
      secondaryReasons: m.secondaryReasons,
      neverSeenCause: m.neverSeenCause,
      referencePrice: m.referencePrice,
      outcomeWindows: m.outcomeWindows,
      filterReason: m.filterReason,
      filterPremiseCorrect: m.filterPremiseCorrect,
      premarketKnownBy: m.premarketKnownBy,
    };
  }

  return {
    tradingDate,
    generatedAt: now.toISOString(),
    hasData,
    sources: {
      moverCoverageRows: movers.length,
      moverCoverageTablePresent,
      sessionMetrics: sessionMetrics != null,
      premarketFocus: focus != null,
      postmarket: postmarket != null,
    },
    premarketFocusPerformance: focus,
    discoveryCoverage: { funnel, fateHistogram, sessionMetricsCheck, sessionMetricsRates },
    neverSeenMovers,
    filteredWinnersLosers,
    consensusRejections,
    riskRejections,
    dataReadinessFailures,
    catalystCoverage,
    repeatingIssues,
    postmarketSummary: postmarket,
    movers: summaries.sort(byAbsMoveDesc),
    moverDetails,
  };
}

/**
 * Read-only assembly entry point. Loads every source itself (all SELECTs,
 * fail-soft on missing producer tables). `opts` injects fixtures for tests.
 */
export async function buildDailyReflectionReport(
  tradingDate: string,
  opts: BuildDailyReflectionOptions = {},
): Promise<DailyReflectionReport> {
  if (!DATE_RE.test(tradingDate)) throw new Error(`tradingDate must be YYYY-MM-DD, got "${tradingDate}"`);
  const now = opts.now ?? new Date();
  const { rows: movers, tablePresent } =
    opts.movers !== undefined ? { rows: opts.movers, tablePresent: true } : await loadMoverCoverage(tradingDate);
  const sessionMetrics =
    opts.sessionMetrics !== undefined ? opts.sessionMetrics : await loadSessionMetrics(tradingDate);
  const focus = await loadFocusPerformance(tradingDate);
  const postmarket = await loadPostmarketSummary(tradingDate);
  return assembleReflectionSections(tradingDate, movers, sessionMetrics, focus, postmarket, tablePresent, now);
}

// ---- Text rendering (presentation helper; no DB access) ---------------------

function fmtPct(v: number | null): string {
  return v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function fateLabel(f: MoverFate): string {
  return f;
}

/**
 * Plain-text rendering of a report for the CLI. Pure: no DB, no side
 * effects. Honest empty output when `hasData` is false.
 */
export function formatDailyReflectionReport(r: DailyReflectionReport): string {
  const L: string[] = [];
  L.push(`Daily reflection — ${r.tradingDate}`);
  L.push('Read-only post-market reflection: explains what happened, never what to trade.');
  if (!r.hasData) {
    L.push('');
    L.push(`No reflection data for ${r.tradingDate} yet.`);
    L.push(
      `Sources: mover_coverage ${r.sources.moverCoverageTablePresent ? `present (${r.sources.moverCoverageRows} rows)` : 'table not present yet (workstream H)'}; ` +
        `session metrics ${r.sources.sessionMetrics ? 'present' : 'absent (workstream I)'}; ` +
        `pre-market focus report ${r.sources.premarketFocus ? 'present' : 'absent'}; ` +
        `post-market report ${r.sources.postmarket ? 'present' : 'absent'}.`,
    );
    return L.join('\n');
  }

  const fp = r.premarketFocusPerformance;
  L.push('');
  L.push('== PREMARKET FOCUS PERFORMANCE ==');
  if (fp) {
    L.push(
      `Focus report v${fp.refreshVersion} (generated ${fp.generatedAt}): ${fp.candidateCount} candidates, ` +
        `${fp.scoredCount} scored, avg total ${fp.avgTotal.toFixed(3)}.`,
    );
    L.push(
      `Tiers — PRIMARY ${fp.tierCounts.PRIMARY}, SECONDARY ${fp.tierCounts.SECONDARY}, ` +
        `WATCH ${fp.tierCounts.WATCH}, REJECTED ${fp.tierCounts.REJECTED}.`,
    );
    const missing = Object.entries(fp.missingInputHistogram);
    L.push(
      missing.length > 0
        ? `Missing inputs: ${missing.map(([k, v]) => `${k}×${v}`).join(', ')}.`
        : 'No missing score inputs recorded.',
    );
  } else {
    L.push('No pre-market focus report for this date.');
  }

  const dc = r.discoveryCoverage;
  L.push('');
  L.push('== DISCOVERY COVERAGE ==');
  L.push(
    `Funnel (mover_coverage): movers ${dc.funnel.movers} → seen ${dc.funnel.seen} → ` +
      `evaluated ${dc.funnel.evaluated} → acted ${dc.funnel.acted}.`,
  );
  if (dc.sessionMetricsCheck) {
    const s = dc.sessionMetricsCheck;
    L.push(`Session metrics check: movers ${s.moversTotal}, seen ${s.moversSeen}.`);
  }
  if (dc.sessionMetricsRates) {
    const rates = Object.entries(dc.sessionMetricsRates).filter(([, v]) => v != null) as Array<[string, number]>;
    L.push(
      rates.length > 0
        ? `Session rates: ${rates.map(([k, v]) => `${k}=${(v * 100).toFixed(1)}%`).join(', ')}.`
        : 'Session metrics present but no rates recorded.',
    );
  }
  const hist = Object.entries(dc.fateHistogram);
  L.push(hist.length > 0 ? `Fates: ${hist.map(([f, n]) => `${f}×${n}`).join(', ')}.` : 'No mover fate rows.');

  L.push('');
  L.push(`== NEVER-SEEN MOVERS (${r.neverSeenMovers.length}) ==`);
  if (r.neverSeenMovers.length === 0) {
    L.push('Every mover was seen by discovery.');
  } else {
    for (const m of r.neverSeenMovers) {
      L.push(`  ${m.symbol.padEnd(8)} ${fmtPct(m.eodMovePct).padStart(9)}  cause: ${m.cause ?? 'not recorded'}`);
    }
  }

  const fw = r.filteredWinnersLosers;
  L.push('');
  L.push(
    `== FILTERED WINNERS-LOSERS (${fw.filteredCount}) == ` +
      `(premise held ${fw.premiseHeld}, premise wrong ${fw.premiseWrong}, unevaluated ${fw.premiseUnevaluated})`,
  );
  if (fw.movers.length === 0) {
    L.push('No filtered movers.');
  } else {
    for (const m of fw.movers) {
      const tag = m.premiseLabel === 'winner' ? 'FILTERED WINNER' : m.premiseLabel === 'loser' ? 'filtered loser' : 'unevaluated';
      L.push(
        `  ${m.symbol.padEnd(8)} ${fmtPct(m.eodMovePct).padStart(9)}  ${tag.padEnd(15)} reason: ${m.filterReason ?? '—'}`,
      );
    }
  }

  const rej = (title: string, rows: RejectedMover[]): void => {
    L.push('');
    L.push(`== ${title} (${rows.length}) ==`);
    if (rows.length === 0) {
      L.push('None.');
    } else {
      for (const m of rows) {
        const reason = m.reasons[0] ?? 'reason not recorded';
        L.push(`  ${m.symbol.padEnd(8)} ${fmtPct(m.eodMovePct).padStart(9)}  ${reason}`);
      }
    }
  };
  rej('CONSENSUS REJECTIONS', r.consensusRejections);
  rej('RISK REJECTIONS', r.riskRejections);

  L.push('');
  L.push(`== DATA-READINESS FAILURES (${r.dataReadinessFailures.movers.length}) ==`);
  if (r.dataReadinessFailures.movers.length === 0) {
    L.push('None.');
  } else {
    for (const m of r.dataReadinessFailures.movers) {
      L.push(`  ${m.symbol.padEnd(8)} ${fmtPct(m.eodMovePct).padStart(9)}  ${(m.reasons[0] ?? 'reason not recorded')}`);
    }
  }
  if (r.dataReadinessFailures.sessionMetricsPrimaryDataReadiness != null) {
    L.push(
      `Session metrics primary_data_readiness: ` +
        `${(r.dataReadinessFailures.sessionMetricsPrimaryDataReadiness * 100).toFixed(1)}%.`,
    );
  }

  const cc = r.catalystCoverage;
  L.push('');
  L.push(`== CATALYST COVERAGE == (with catalyst evidence ${cc.withCatalyst}, without ${cc.withoutCatalyst})`);
  if (cc.withCatalystSymbols.length > 0) L.push(`  With: ${cc.withCatalystSymbols.join(', ')}`);
  if (cc.withoutCatalystSymbols.length > 0) L.push(`  Without: ${cc.withoutCatalystSymbols.join(', ')}`);

  L.push('');
  L.push('== TOP MOVERS — ARGUS FATE PER SYMBOL ==');
  if (r.movers.length === 0) {
    L.push('No movers recorded.');
  } else {
    for (const m of r.movers.slice(0, 20)) {
      L.push(`  ${m.symbol.padEnd(8)} ${fmtPct(m.eodMovePct).padStart(9)}  ${fateLabel(m.primaryFate)}`);
    }
    if (r.movers.length > 20) L.push(`  … and ${r.movers.length - 20} more (see --json or the TUI drill-down).`);
  }

  if (r.repeatingIssues.length > 0) {
    L.push('');
    L.push('== REPEATING ISSUES ==');
    for (const issue of r.repeatingIssues) L.push(`  - ${issue}`);
  }

  const pm = r.postmarketSummary;
  if (pm) {
    L.push('');
    L.push(`== POST-MARKET (${pm.status}, ${pm.generatedAt}) ==`);
    L.push(`Symbols touched: ${pm.totalSymbolsTouched}.`);
    const cls = Object.entries(pm.byClassification);
    if (cls.length > 0) L.push(`Classifications: ${cls.map(([k, v]) => `${k}×${v}`).join(', ')}.`);
    for (const f of pm.findings.slice(0, 5)) {
      L.push(`  - ${f.title ?? 'finding'}${f.detail ? `: ${f.detail}` : ''}`);
    }
  }

  return L.join('\n');
}
