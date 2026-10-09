/**
 * Daily reflection orchestrator (2026-10-06, local-only, Part B workstream H).
 *
 * runDailyReflection(tradingDate): builds the EOD benchmark mover cohort
 * (moverCohort.ts) -> reconciles every mover against the real discovery/
 * evaluation coverage (coverageReconciler.ts) -> persists one mover_coverage row
 * per mover. Idempotent per (trading_date, symbol) via the UNIQUE constraint
 * (onConflictDoNothing) - a re-run for the same date never duplicates rows.
 *
 * Works for a past date (forward-validation backfill, e.g. 2026-10-05): the
 * cohort builder recomputes the benchmark from historical bars when the live
 * screener cannot serve that date, and the reconciler only reads persisted
 * evidence - nothing requires "today".
 *
 * Diagnostic only. Never imports RiskEngine/OMS/BrokerManager, never emits
 * TRADE_IDEA_GENERATED, never changes a threshold, never places an order.
 */
import { db, sqliteDb } from '../db';
import * as schema from '../db/schema';
import { eq } from 'drizzle-orm';
import { buildMoverCohort, type MoverDataProvider } from './moverCohort';
import {
  reconcileMover,
  createSqliteCoverageEvidenceStore,
  PRIMARY_FATES,
  type CoverageEvidenceStore,
  type CoverageVerdict,
  type PrimaryFate,
} from './coverageReconciler';
import { logErrorSafely } from '../core/SecretRedaction';
import { weekStartMonday, computeAndPersistWeeklyDigest } from './weeklyDigest';
import { callOutcomeAudits as runOutcomeAudits } from './outcomeAudits';

export type ReflectionCohortStatus = 'OK' | 'INSUFFICIENT_EVIDENCE';

export interface DailyReflectionResult {
  tradingDate: string;
  cohortStatus: ReflectionCohortStatus;
  cohortReason: string | null;
  moversConsidered: number;
  rowsPersisted: number;
  fateCounts: Record<string, number>;
  generatedAtIso: string;
}

/**
 * Hook point for workstream I (outcome audits) - WIRED 2026-10-06.
 *
 * Delegates to src/server/reflection/outcomeAudits.ts: the discovery-filter /
 * risk-rejection / pre-market effectiveness audits that write
 * reflection_session_metrics. This module (workstream H) owns the
 * mover_coverage reconciliation the audits read; the audit computations
 * themselves belong to I. Called by runDailyReflection() after persistence.
 * Failures are contained here and logged - they never break H's persisted
 * reconciliation, and the audits never touch trading state.
 */
export async function callOutcomeAudits(tradingDate: string): Promise<void> {
  try {
    await runOutcomeAudits(tradingDate);
  } catch (e) {
    logErrorSafely('[dailyReflection] callOutcomeAudits failed', e);
  }
}

/**
 * Hook point for workstream K (session metrics / weekly digest).
 *
 * Wired 2026-10-08 (docs-feature scan): weeklyDigest.ts's aggregation is
 * complete and tested, so this hook now triggers computeAndPersistWeeklyDigest
 * for the Monday-start week containing tradingDate. The digest write is
 * idempotent (onConflictDoUpdate on weekStart) and the caller contains sync
 * failures; async rejections are logged here. Diagnostic-only: never touches
 * the trading spine.
 */
export function computeSessionMetrics(tradingDate: string): void {
  try {
    const weekStart = weekStartMonday(tradingDate);
    void computeAndPersistWeeklyDigest(weekStart).catch((e) =>
      logErrorSafely('[dailyReflection] weekly digest failed', e),
    );
  } catch (e) {
    logErrorSafely('[dailyReflection] computeSessionMetrics failed', e);
  }
}

function toRow(v: CoverageVerdict, tradingDate: string) {
  return {
    tradingDate,
    symbol: v.symbol,
    eodMovePct: v.eodMovePct,
    primaryFate: v.primaryFate,
    secondaryReasons: JSON.stringify(v.secondaryReasons),
    neverSeenCause: v.neverSeenCause,
    referencePrice: v.referencePrice,
    outcomeWindows: JSON.stringify(v.outcomeWindows),
    filterReason: v.filterReason,
    filterPremiseCorrect: v.filterPremiseCorrect,
    premarketKnownBy: JSON.stringify(v.premarketKnownBy),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Runs the full day-movers-vs-coverage reconciliation for one trading date.
 * Safe to call multiple times for the same date (idempotent); safe for past
 * dates (backfill). Returns a summary - never throws for data problems (those
 * become INSUFFICIENT_EVIDENCE), only for invalid input.
 */
export async function runDailyReflection(
  tradingDate: string,
  opts?: { provider?: MoverDataProvider; store?: CoverageEvidenceStore },
): Promise<DailyReflectionResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradingDate)) {
    throw new Error(`runDailyReflection: invalid tradingDate '${tradingDate}' (expected YYYY-MM-DD)`);
  }
  const generatedAtIso = new Date().toISOString();
  const cohort = await buildMoverCohort(tradingDate, { provider: opts?.provider });
  if (cohort.insufficientEvidence) {
    // Honest degradation: no benchmark, no rows, no fabricated movers.
    logErrorSafely(`[dailyReflection] ${tradingDate}: cohort insufficient - ${cohort.insufficientReason}`, null);
    return {
      tradingDate,
      cohortStatus: 'INSUFFICIENT_EVIDENCE',
      cohortReason: cohort.insufficientReason,
      moversConsidered: 0,
      rowsPersisted: 0,
      fateCounts: {},
      generatedAtIso,
    };
  }

  const store = opts?.store ?? createSqliteCoverageEvidenceStore();
  const verdicts: CoverageVerdict[] = [];
  for (const member of cohort.members) {
    try {
      verdicts.push(await reconcileMover(member, tradingDate, store));
    } catch (e) {
      // One bad member must never kill the day's run - record it honestly.
      logErrorSafely(`[dailyReflection] reconcile failed for ${member.symbol}`, e);
      verdicts.push({
        symbol: member.symbol,
        primaryFate: 'INSUFFICIENT_EVIDENCE',
        secondaryReasons: [`reconcile threw: ${e instanceof Error ? e.message : String(e)} - no fate asserted`],
        neverSeenCause: null,
        filterReason: null,
        filterPremiseCorrect: null,
        premarketKnownBy: { plan0400: false, refresh0915: false, fastLane: false, discovery: false },
        outcomeWindows: { eod: { movePct: member.eodMovePct, referencePrice: member.referencePrice, dayVolumeShares: member.dayVolumeShares, direction: member.direction } },
        referencePrice: member.referencePrice,
        eodMovePct: member.eodMovePct,
      });
    }
  }

  for (const v of verdicts) {
    await db.insert(schema.moverCoverage).values(toRow(v, tradingDate)).onConflictDoNothing({
      target: [schema.moverCoverage.tradingDate, schema.moverCoverage.symbol],
    });
  }
  const counted = sqliteDb.prepare(`SELECT COUNT(*) c FROM mover_coverage WHERE trading_date = ?`).get(tradingDate) as { c: number };

  const fateCounts: Record<string, number> = {};
  for (const f of PRIMARY_FATES) fateCounts[f] = 0;
  for (const v of verdicts) fateCounts[v.primaryFate] = (fateCounts[v.primaryFate] ?? 0) + 1;

  // Sibling-workstream hook points. callOutcomeAudits is wired to workstream I
  // (failure-contained inside the hook); computeSessionMetrics is still a no-op
  // pending workstream K. Neither may break H's persisted reconciliation.
  await callOutcomeAudits(tradingDate);
  try { computeSessionMetrics(tradingDate); } catch (e) { logErrorSafely('[dailyReflection] computeSessionMetrics hook failed', e); }

  return {
    tradingDate,
    cohortStatus: 'OK',
    cohortReason: null,
    moversConsidered: cohort.members.length,
    rowsPersisted: counted.c,
    fateCounts,
    generatedAtIso,
  };
}

/** Reads persisted reconciliation rows for a date (e.g. for reports/digests). */
export async function getMoverCoverage(tradingDate: string): Promise<Array<typeof schema.moverCoverage.$inferSelect>> {
  return db.select().from(schema.moverCoverage).where(eq(schema.moverCoverage.tradingDate, tradingDate));
}

export type { PrimaryFate };
