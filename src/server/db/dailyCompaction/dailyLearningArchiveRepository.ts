/**
 * Daily Learning Compaction, Phase 1 - read-only query API (§14). Deliberately not yet wired into
 * live trading or model learning - this phase only creates trustworthy persistent learning data.
 */
import { and, asc, between, eq } from 'drizzle-orm';
import { db } from '../index';
import { dailyLearningArchive } from '../schema';
import type { DailyCompactionSummary } from './types';

export interface DailyLearningRow {
  tradingDate: string;
  sourceType: string;
  compactionStatus: string;
  sourceRowCount: number;
  summary: DailyCompactionSummary | null;
  createdAt: number;
  verifiedAt: number | null;
  rawPurgedAt: number | null;
}

function toRow(r: typeof dailyLearningArchive.$inferSelect): DailyLearningRow {
  let summary: DailyCompactionSummary | null = null;
  try { summary = JSON.parse(r.summaryJson); } catch { summary = null; }
  return {
    tradingDate: r.tradingDate,
    sourceType: r.sourceType,
    compactionStatus: r.compactionStatus,
    sourceRowCount: r.sourceRowCount,
    summary,
    createdAt: r.createdAt,
    verifiedAt: r.verifiedAt,
    rawPurgedAt: r.rawPurgedAt,
  };
}

export async function getDailyLearning(tradingDate: string, sourceType: string): Promise<DailyLearningRow | null> {
  const row = db.select().from(dailyLearningArchive)
    .where(and(eq(dailyLearningArchive.tradingDate, tradingDate), eq(dailyLearningArchive.sourceType, sourceType)))
    .all()[0];
  return row ? toRow(row) : null;
}

export async function listDailyLearning(from: string, to: string, sourceType: string): Promise<DailyLearningRow[]> {
  const rows = db.select().from(dailyLearningArchive)
    .where(and(eq(dailyLearningArchive.sourceType, sourceType), between(dailyLearningArchive.tradingDate, from, to)))
    .orderBy(asc(dailyLearningArchive.tradingDate))
    .all();
  return rows.map(toRow);
}
