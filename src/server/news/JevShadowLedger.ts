/**
 * ==========================================================
 * Module:
 * JevShadowLedger.ts
 *
 * Purpose:
 * Phase 1 agreement ledger for Jev shadow scoring. Persists every Jev shadow
 * score plus, when the same article also received LLM analysis, the LLM's own
 * scores and the computed agreement — the calibration evidence Phase 2's exit
 * criteria require. Write-only from the news path's perspective: nothing here
 * is ever read by any trading decision.
 *
 * Failure semantics: ledger writes are best-effort and never block the news
 * cycle. A failed insert is logged and dropped — losing a shadow observation is
 * acceptable; delaying a trading cycle is not.
 * ==========================================================
 */

import { randomUUID } from 'crypto';
import { db } from '../db';
import * as schema from '../db/schema';
import { sql } from 'drizzle-orm';
import { JevNewsScore, mapJevScoreToAnalysisFields } from './JevNewsTriage';
import { AIAnalysisResult } from './NewsScoringEngine';

export interface ShadowLedgerEntry {
  articleFingerprint: string;
  symbol: string;
  traceId: string;
  jevScore: JevNewsScore;
  /** The LLM's analysis of the SAME article, when it exists (escalated articles). */
  llmAnalysis?: AIAnalysisResult | null;
}

/**
 * Directional agreement: 1 when Jev's sentiment direction matches the LLM's
 * trading bias, 0 when they disagree, null when the LLM side is absent.
 * Neutral-vs-neutral counts as agreement; neutral-vs-directional does not.
 */
export function computeSentimentAgreement(
  jevSentiment: 'bullish' | 'bearish' | 'neutral',
  llmBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
): 1 | 0 {
  const jevDir = jevSentiment === 'bullish' ? 1 : jevSentiment === 'bearish' ? -1 : 0;
  const llmDir = llmBias === 'BULLISH' ? 1 : llmBias === 'BEARISH' ? -1 : 0;
  return jevDir === llmDir ? 1 : 0;
}

export async function recordShadowScore(entry: ShadowLedgerEntry): Promise<void> {
  const mapped = mapJevScoreToAnalysisFields(entry.jevScore);
  const llm = entry.llmAnalysis ?? null;
  try {
    await db.insert(schema.jevShadowScores).values({
      id: randomUUID(),
      articleFingerprint: entry.articleFingerprint,
      symbol: entry.symbol,
      traceId: entry.traceId,
      jevModel: entry.jevScore.model,
      jevRelevantProb: entry.jevScore.relevantProb,
      jevRelevantConf: entry.jevScore.minConfidence,
      jevSentiment: entry.jevScore.sentiment,
      jevSentimentConf: entry.jevScore.sentimentConf,
      jevSentimentProbs: JSON.stringify(entry.jevScore.sentimentProbs),
      jevImpactScore: entry.jevScore.impactScore,
      jevImpactConf: entry.jevScore.impactConf,
      jevSurpriseProb: entry.jevScore.surpriseProb,
      jevContradictionProb: entry.jevScore.contradictionProb,
      jevUrgencyScore: entry.jevScore.urgencyScore,
      jevUrgencyConf: entry.jevScore.urgencyConf,
      jevInputTokens: entry.jevScore.inputTokens,
      jevLatencyMs: entry.jevScore.latencyMs,
      llmSentimentScore: llm?.sentimentScore ?? null,
      llmTradingBias: llm?.tradingBias ?? null,
      llmMarketImpactScore: llm?.marketImpactScore ?? null,
      llmConfidence: llm?.confidence ?? null,
      llmSurprise: llm?.marketSurprise ?? null,
      sentimentAgree: llm ? computeSentimentAgreement(entry.jevScore.sentiment, llm.tradingBias) : null,
      scoredAt: new Date().toISOString(),
    });
  } catch (e) {
    // Best-effort: a lost shadow observation is acceptable; a blocked cycle is not.
    console.warn('[JevShadowLedger] insert failed (dropped observation):', (e as Error)?.message || e);
  }
}

export interface CalibrationSummary {
  totalScored: number;
  withLlmComparison: number;
  sentimentAgreementRate: number | null; // 0..1, null when no comparisons yet
  avgJevLatencyMs: number | null;
  totalJevInputTokens: number;
  estimatedCostUsd: number; // at $0.042 / 1M input tokens
}

/** Phase 1 exit-criteria query: how much agreement evidence has been collected. */
export async function getCalibrationSummary(): Promise<CalibrationSummary> {
  try {
    const rows = await db
      .select({
        total: sql<number>`count(*)`,
        compared: sql<number>`count(${schema.jevShadowScores.sentimentAgree})`,
        agreed: sql<number>`coalesce(sum(${schema.jevShadowScores.sentimentAgree}), 0)`,
        avgLatency: sql<number | null>`avg(${schema.jevShadowScores.jevLatencyMs})`,
        totalTokens: sql<number>`coalesce(sum(${schema.jevShadowScores.jevInputTokens}), 0)`,
      })
      .from(schema.jevShadowScores);
    const r = rows[0] ?? { total: 0, compared: 0, agreed: 0, avgLatency: null, totalTokens: 0 };
    return {
      totalScored: Number(r.total) || 0,
      withLlmComparison: Number(r.compared) || 0,
      sentimentAgreementRate: Number(r.compared) > 0 ? Number(r.agreed) / Number(r.compared) : null,
      avgJevLatencyMs: r.avgLatency == null ? null : Number(r.avgLatency),
      totalJevInputTokens: Number(r.totalTokens) || 0,
      estimatedCostUsd: (Number(r.totalTokens) || 0) / 1_000_000 * 0.042,
    };
  } catch (e) {
    console.warn('[JevShadowLedger] calibration summary failed:', (e as Error)?.message || e);
    return { totalScored: 0, withLlmComparison: 0, sentimentAgreementRate: null, avgJevLatencyMs: null, totalJevInputTokens: 0, estimatedCostUsd: 0 };
  }
}

export interface ConfidenceBucket {
  /** Bucket lower bound (inclusive), e.g. 0.7 for the 0.70–0.80 bucket. */
  bucketLow: number;
  bucketHigh: number;
  compared: number; // articles with LLM comparison in this bucket
  agreed: number;
  agreementRate: number | null;
}

export interface ThresholdAnalysis {
  buckets: ConfidenceBucket[];
  /** Human-readable recommendation. Never auto-applies anything. */
  recommendation: string;
}

/**
 * Phase 3 widening hook: bucket the Jev-vs-LLM agreement by Jev's own confidence,
 * so a human can see what the agreement rate WOULD be at candidate escalation
 * thresholds. Read-only analysis — it never changes any threshold itself.
 * Widening a threshold requires explicit operator action after reviewing this.
 */
export async function analyzeAgreementByConfidence(): Promise<ThresholdAnalysis> {
  const bucketEdges = [0.5, 0.6, 0.7, 0.8, 0.9, 1.01];
  const buckets: ConfidenceBucket[] = [];
  try {
    for (let i = 0; i < bucketEdges.length - 1; i++) {
      const low = bucketEdges[i];
      const high = bucketEdges[i + 1];
      // jev_relevant_conf stores the min confidence across questions per row.
      const rows = await db
        .select({
          compared: sql<number>`count(*)`,
          agreed: sql<number>`coalesce(sum(${schema.jevShadowScores.sentimentAgree}), 0)`,
        })
        .from(schema.jevShadowScores)
        .where(sql`${schema.jevShadowScores.sentimentAgree} IS NOT NULL
          AND ${schema.jevShadowScores.jevRelevantConf} >= ${low}
          AND ${schema.jevShadowScores.jevRelevantConf} < ${high}`);
      const r = rows[0] ?? { compared: 0, agreed: 0 };
      const compared = Number(r.compared) || 0;
      buckets.push({
        bucketLow: low,
        bucketHigh: Math.min(high, 1.0),
        compared,
        agreed: Number(r.agreed) || 0,
        agreementRate: compared > 0 ? Number(r.agreed) / compared : null,
      });
    }
  } catch (e) {
    console.warn('[JevShadowLedger] threshold analysis failed:', (e as Error)?.message || e);
  }

  // Conservative recommendation: the lowest bucket edge at/above which agreement
  // is >= 90% over a meaningful sample (>= 30 comparisons). Advisory only.
  let recommendation = 'insufficient comparison data to recommend any threshold change';
  for (const b of buckets) {
    if (b.compared >= 30 && (b.agreementRate ?? 0) >= 0.9) {
      recommendation =
        `bucket [${b.bucketLow.toFixed(2)}, ${b.bucketHigh.toFixed(2)}]: ` +
        `${(b.agreementRate! * 100).toFixed(1)}% agreement over ${b.compared} comparisons — ` +
        `candidate for lowering jevEscalationConfidenceThreshold to ${b.bucketLow.toFixed(2)} after human review`;
      break;
    }
  }
  return { buckets, recommendation };
}
