/**
 * Weekly reflection digest - DB-backed layer (migration 0095).
 *
 * Reads the week's COMPLETED postmarket_reports, aggregates recurring blind-spot patterns
 * via the pure weeklyDigestAggregate.ts, and upserts them into weekly_reflection_digest.
 *
 * Diagnostic only, same safety contract as PostMarketAnalysis.ts / MissedOpportunityDetector.ts:
 * never imports RiskEngine, OMS, or BrokerManager; never emits TRADE_IDEA_GENERATED /
 * CHIEF_APPROVED_IDEA; the only table it writes is weekly_reflection_digest (asserted by
 * reflectionSafety.test.ts's write-table allow-list). Nothing in the live trading pipeline
 * reads this table.
 */
import { db } from '../db';
import * as schema from '../db/schema';
import { and, eq, gte, lt } from 'drizzle-orm';
import type { PostMarketReport } from '../continuous/PostMarketAnalysis';
import { readNeverSeenMovers } from '../continuous/PostMarketAnalysis';
import {
  aggregateWeeklyDigest,
  DEFAULT_MIN_OCCURRENCES,
  type AggregateOptions,
  type DailyReflectionInput,
  type WeeklyDigestPattern,
} from './weeklyDigestAggregate';

export type { WeeklyDigestPattern };

/** Monday ('YYYY-MM-DD') of the calendar week containing the given trading date. */
export function weekStartMonday(tradingDate: string): string {
  const d = new Date(`${tradingDate}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0 = Sunday
  const back = (dow + 6) % 7; // days since Monday
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

function addDays(dateIso: string, n: number): string {
  const d = new Date(`${dateIso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function toDailyInput(report: PostMarketReport): DailyReflectionInput {
  return {
    tradingDate: report.tradingDate,
    blindSpots: report.blindSpots.map((s) => ({
      patternKey: s.patternKey,
      pattern: s.pattern,
      affectedSymbolCount: s.affectedSymbolCount,
      evidence: s.evidence,
    })),
    findings: report.findings.map((f) => ({
      symbol: f.symbol,
      classification: f.classification,
      filteredReasons: f.filteredReasons,
    })),
    narratives: report.narratives.map((n) => ({
      symbol: n.symbol,
      primaryFailureCategory: n.primaryFailureCategory,
      newsTimeline: n.newsTimeline.map((e) => ({ eventType: e.eventType })),
    })),
    rejectedCandidateAudits: report.rejectedCandidateAudits.map((a) => ({
      symbol: a.symbol,
      verdict: a.verdict,
    })),
    // Workstream H feed: [] until mover_coverage exists - never fabricated.
    neverSeenMovers: readNeverSeenMovers(report.tradingDate),
  };
}

/** All COMPLETED daily reports in [weekStart, weekStart + 7d), oldest first. */
export async function readCompletedReportsForWeek(weekStart: string): Promise<DailyReflectionInput[]> {
  const weekEnd = addDays(weekStart, 7);
  const rows = await db.select().from(schema.postmarketReports).where(
    and(
      eq(schema.postmarketReports.status, 'COMPLETED'),
      gte(schema.postmarketReports.tradingDate, weekStart),
      lt(schema.postmarketReports.tradingDate, weekEnd),
    ),
  );
  rows.sort((a, b) => (a.tradingDate < b.tradingDate ? -1 : 1));
  return rows.map((row) => {
    const parsed = JSON.parse(row.findingsJson);
    const report: PostMarketReport = {
      tradingDate: row.tradingDate,
      generatedAtIso: row.generatedAt,
      argusCommit: row.argusCommit,
      totalSymbolsTouched: row.totalSymbolsTouched,
      byClassification: JSON.parse(row.byClassificationJson),
      findings: parsed.findings ?? [],
      narratives: parsed.narratives ?? [],
      flowScorecard: parsed.flowScorecard,
      blindSpots: parsed.blindSpots ?? [],
      rejectedCandidateAudits: parsed.rejectedCandidateAudits ?? [],
    };
    return toDailyInput(report);
  });
}

/** Pure aggregation over the week's completed reports - no persistence. */
export async function computeWeeklyDigest(
  weekStart: string,
  opts: AggregateOptions = {},
): Promise<WeeklyDigestPattern[]> {
  const days = await readCompletedReportsForWeek(weekStart);
  return aggregateWeeklyDigest(days, { minOccurrences: DEFAULT_MIN_OCCURRENCES, ...opts });
}

/** Upserts digest patterns under the UNIQUE(week_start, pattern_key) constraint - a later
 *  run for the same week overwrites rather than duplicating. */
export async function persistWeeklyDigest(weekStart: string, patterns: WeeklyDigestPattern[]): Promise<void> {
  const createdAt = new Date().toISOString();
  for (const p of patterns) {
    await db.insert(schema.weeklyReflectionDigest).values({
      weekStart,
      patternKey: p.patternKey,
      occurrences: p.occurrences,
      symbols: JSON.stringify(p.symbols),
      firstSeen: p.firstSeen,
      lastSeen: p.lastSeen,
      createdAt,
    }).onConflictDoUpdate({
      target: [schema.weeklyReflectionDigest.weekStart, schema.weeklyReflectionDigest.patternKey],
      set: {
        occurrences: p.occurrences,
        symbols: JSON.stringify(p.symbols),
        firstSeen: p.firstSeen,
        lastSeen: p.lastSeen,
        createdAt,
      },
    });
  }
}

/** Full pipeline: read the week's completed reports, aggregate with the recurrence gate,
 *  persist. Returns the persisted patterns. */
export async function computeAndPersistWeeklyDigest(
  weekStart: string,
  opts: AggregateOptions = {},
): Promise<WeeklyDigestPattern[]> {
  const patterns = await computeWeeklyDigest(weekStart, opts);
  await persistWeeklyDigest(weekStart, patterns);
  return patterns;
}
