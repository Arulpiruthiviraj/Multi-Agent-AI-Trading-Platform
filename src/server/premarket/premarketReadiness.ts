/**
 * Premarket readiness — split subsystem checks (2026-10-08, workstream D defect #6).
 *
 * The operator readiness checklist used to report ONE combined 'premarket' check that
 * only looked at the premarket_focus_reports table. A missing focus report and a dead
 * trade-plan pipeline produced the same verdict, hiding which subsystem was broken.
 * These are now two independent checks with independent evidence:
 *
 * - tradePlanPipelineHealthy: is the trade-plan pipeline (TradePlanBuilder's premarket
 *   lifecycle) running and producing? Evidence: the trade_plans ledger for the trading
 *   date — plan count, max refresh version, first/last refresh activity. A scheduled
 *   refresh window that fully elapsed with no activity since its start is a stall
 *   (FAIL); no plans at all is "no refresh completed yet" (WARN, never a false dead).
 * - premarketFocusReportHealthy: was a focus report produced for the latest completed
 *   refresh? Evidence: premarket_focus_reports rows for the trading date vs the latest
 *   completed refresh version (max plan refreshVersion). A missing or stale report is
 *   WARN — the report is observability, never a trading gate.
 *
 * Empty-history rule (defect #5 follow-through): when no refresh has completed yet
 * (engine started mid-session, pre-first-build), the absence of a report is reported
 * explicitly as "no refresh completed yet" — never as corrupt data, never silently
 * ignored, and never as a pipeline stall.
 *
 * Pure evaluators (evaluateTradePlanPipeline / evaluateFocusReportHealth) take
 * injected evidence + clock so tests can assert every branch deterministically.
 * The gather*Evidence functions own the DB reads (dynamic db import, same pattern
 * as PremarketFocusReport.ts — this module stays light for route/test import).
 *
 * Boundary: diagnostic only. Never touches ChiefTrader/RiskEngine/OMS/BrokerManager,
 * never emits trade ideas, and never changes the LIVE readiness engine's
 * LIVE_NO_GO semantics (owned by src/server/core/liveReadinessEngine.ts, untouched).
 */
import { getTradingDateStr, tradingWallTimeToIso } from '../core/TradingCalendar';
import { continuousIntelligence } from '../config/continuousIntelligence';

export type PremarketCheckStatus = 'PASS' | 'WARN' | 'FAIL';

export interface PremarketSubsystemCheck {
  status: PremarketCheckStatus;
  /** Human reason, always carrying the last-success timestamp when one exists. */
  detail: string;
  /** ISO instant of the subsystem's last successful production, null when never. */
  lastSuccessAt: string | null;
}

export interface TradePlanPipelineEvidence {
  tradingDate: string;
  planCount: number;
  maxRefreshVersion: number;
  /** Earliest (originalCreatedAt ?? createdAt) across the date's plans, ISO. */
  firstActivityAt: string | null;
  /** Latest (refreshedAt ?? createdAt) across the date's plans, ISO. */
  lastActivityAt: string | null;
}

export interface RefreshWindow {
  kind: string;
  startEt: string;
  endEt: string;
}

/**
 * The scheduled refresh windows, from the same config TradePlanBuilder's
 * kindWindowEt() reads (config/continuousIntelligence.json) — one source of
 * truth, no duplicated wall-clock literals.
 */
export function premarketRefreshWindows(): RefreshWindow[] {
  const c = continuousIntelligence;
  return [
    { kind: 'MID_MORNING', startEt: c.premarketMidMorningRefreshStartEt, endEt: c.premarketMidMorningRefreshEndEt },
    { kind: 'LATE_REFRESH', startEt: c.premarketRefreshWindowStart, endEt: c.premarketRefreshWindowEnd },
    { kind: 'PREOPEN_VALIDATION', startEt: c.premarketPreopenValidationStartEt, endEt: c.premarketPreopenValidationEndEt },
  ];
}

/**
 * Pure: is the trade-plan pipeline running and producing?
 *
 * - No plans for the date (or no activity timestamp): WARN "no refresh completed
 *   yet" — the pipeline has not produced this session. Explicitly not a stall
 *   and not an error.
 * - A scheduled window fully elapsed (now >= end) with last activity before its
 *   start: FAIL naming the missed window(s) — the pipeline lived through a
 *   window it should have refreshed in and produced nothing. A late engine start
 *   cannot false-trigger this: its initial build sets lastActivity after all
 *   earlier window starts.
 * - Otherwise: PASS with plan count, version, and last-activity timestamp.
 */
export function evaluateTradePlanPipeline(
  evidence: TradePlanPipelineEvidence,
  now: Date,
  windows: RefreshWindow[],
): PremarketSubsystemCheck {
  const { tradingDate } = evidence;
  if (evidence.planCount === 0 || evidence.lastActivityAt == null) {
    return {
      status: 'WARN',
      detail:
        `no refresh completed yet for ${tradingDate} — the trade-plan pipeline has not ` +
        `produced plans this session (not an error, not a stall)`,
      lastSuccessAt: null,
    };
  }
  const lastActivityMs = Date.parse(evidence.lastActivityAt);
  const nowMs = now.getTime();
  const missed: string[] = [];
  for (const w of windows) {
    let startMs: number;
    let endMs: number;
    try {
      startMs = Date.parse(tradingWallTimeToIso(tradingDate, w.startEt));
      endMs = Date.parse(tradingWallTimeToIso(tradingDate, w.endEt));
    } catch {
      continue; // Unresolvable window: cannot judge it — never FAIL on it.
    }
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (nowMs >= endMs && Number.isFinite(lastActivityMs) && lastActivityMs < startMs) {
      missed.push(`${w.kind} ${w.startEt}-${w.endEt} ET`);
    }
  }
  if (missed.length > 0) {
    return {
      status: 'FAIL',
      detail:
        `pipeline stall: no refresh activity since ${evidence.lastActivityAt} ` +
        `(v${evidence.maxRefreshVersion}, ${evidence.planCount} plans for ${tradingDate}) — ` +
        `missed window(s): ${missed.join(', ')}`,
      lastSuccessAt: evidence.lastActivityAt,
    };
  }
  return {
    status: 'PASS',
    detail:
      `pipeline active: ${evidence.planCount} plans for ${tradingDate}, ` +
      `latest refresh activity ${evidence.lastActivityAt} (v${evidence.maxRefreshVersion})`,
    lastSuccessAt: evidence.lastActivityAt,
  };
}

export interface FocusReportEvidence {
  tradingDate: string;
  /** Max plan refreshVersion for the date; 0 when no refresh has completed. */
  latestCompletedRefreshVersion: number;
  latestReport: { refreshVersion: number; generatedAt: string } | null;
}

/**
 * Pure: was a focus report produced for the latest completed refresh?
 *
 * - No completed refresh (version 0): WARN "no refresh completed yet" — no
 *   report is expected; the absence is reported, never treated as corrupt and
 *   never silently ignored.
 * - Completed refresh but no report row: WARN — the subscriber is not
 *   producing. This is independent of pipeline health: the pipeline may be
 *   PASS while this is WARN (and vice versa).
 * - Report version == latest completed refresh: PASS with the report's
 *   generation timestamp.
 * - Report older than the latest completed refresh: WARN (stale).
 * - Report newer than the latest completed refresh: WARN (version skew —
 *   honest anomaly, not a false healthy).
 */
export function evaluateFocusReportHealth(evidence: FocusReportEvidence): PremarketSubsystemCheck {
  const { tradingDate, latestCompletedRefreshVersion } = evidence;
  if (latestCompletedRefreshVersion <= 0) {
    return {
      status: 'WARN',
      detail:
        `no refresh completed yet for ${tradingDate} — no focus report expected ` +
        `(absence reported, not corrupt, not ignored)`,
      lastSuccessAt: null,
    };
  }
  const r = evidence.latestReport;
  if (r == null) {
    return {
      status: 'WARN',
      detail:
        `pipeline completed refresh v${latestCompletedRefreshVersion} for ${tradingDate} ` +
        `but no focus report row exists — the focus-report subscriber is not producing`,
      lastSuccessAt: null,
    };
  }
  if (r.refreshVersion === latestCompletedRefreshVersion) {
    return {
      status: 'PASS',
      detail:
        `focus report v${r.refreshVersion} for ${tradingDate} generated at ${r.generatedAt}`,
      lastSuccessAt: r.generatedAt,
    };
  }
  if (r.refreshVersion < latestCompletedRefreshVersion) {
    return {
      status: 'WARN',
      detail:
        `focus report stale for ${tradingDate}: latest row v${r.refreshVersion} ` +
        `(generated ${r.generatedAt}) < latest completed refresh v${latestCompletedRefreshVersion}`,
      lastSuccessAt: r.generatedAt,
    };
  }
  return {
    status: 'WARN',
    detail:
      `focus report v${r.refreshVersion} for ${tradingDate} is ahead of the latest ` +
      `completed pipeline refresh v${latestCompletedRefreshVersion} — investigate version skew`,
    lastSuccessAt: r.generatedAt,
  };
}

/** Read the trade_plans ledger for a trading date into pipeline evidence. */
export async function gatherTradePlanPipelineEvidence(
  tradingDate?: string,
): Promise<TradePlanPipelineEvidence> {
  const date = tradingDate ?? getTradingDateStr(new Date());
  const { db } = await import('../db');
  const { tradePlans } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');
  const rows = await db
    .select({
      refreshVersion: tradePlans.refreshVersion,
      refreshedAt: tradePlans.refreshedAt,
      createdAt: tradePlans.createdAt,
      originalCreatedAt: tradePlans.originalCreatedAt,
    })
    .from(tradePlans)
    .where(eq(tradePlans.planDate, date));
  let maxRefreshVersion = 0;
  let firstActivityAt: string | null = null;
  let lastActivityAt: string | null = null;
  for (const r of rows) {
    maxRefreshVersion = Math.max(maxRefreshVersion, r.refreshVersion ?? 0);
    const created = r.originalCreatedAt ?? r.createdAt;
    if (created != null && (firstActivityAt == null || created < firstActivityAt)) {
      firstActivityAt = created;
    }
    const activity = r.refreshedAt ?? r.createdAt;
    if (activity != null && (lastActivityAt == null || activity > lastActivityAt)) {
      lastActivityAt = activity;
    }
  }
  return { tradingDate: date, planCount: rows.length, maxRefreshVersion, firstActivityAt, lastActivityAt };
}

/** Read the latest focus-report row + the pipeline's latest completed refresh version. */
export async function gatherFocusReportEvidence(
  tradingDate?: string,
): Promise<FocusReportEvidence> {
  const date = tradingDate ?? getTradingDateStr(new Date());
  const pipeline = await gatherTradePlanPipelineEvidence(date);
  const { db } = await import('../db');
  const { premarketFocusReports } = await import('../db/schema');
  const { eq, desc } = await import('drizzle-orm');
  const rows = await db
    .select({
      refreshVersion: premarketFocusReports.refreshVersion,
      generatedAt: premarketFocusReports.generatedAt,
    })
    .from(premarketFocusReports)
    .where(eq(premarketFocusReports.planDate, date))
    .orderBy(desc(premarketFocusReports.refreshVersion))
    .limit(1);
  return {
    tradingDate: date,
    latestCompletedRefreshVersion: pipeline.maxRefreshVersion,
    latestReport:
      rows.length > 0
        ? { refreshVersion: rows[0].refreshVersion, generatedAt: rows[0].generatedAt }
        : null,
  };
}
