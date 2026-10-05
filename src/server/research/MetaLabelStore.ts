/**
 * MetaLabelStore.ts
 *
 * 2026-10-05: Feature snapshot capture for meta-labeling (knowledge-base/entries/ml-meta-labeling.md).
 *
 * The research program's chosen ML architecture: a meta-model that predicts whether a
 * triggered primary-strategy setup will be profitable after costs. That model needs
 * labeled training rows: (features at signal time) -> (realized post-cost outcome).
 *
 * This module captures the FEATURE side. The OUTCOME side already exists:
 * agent_predictions -> predictionOutcomes (PredictionOutcomeEvaluator grades on its own
 * horizon). A training row is meta_label_features JOIN predictionOutcomes on prediction_id.
 *
 * Critical design points:
 * - Capture happens when triggerMet=true, BEFORE the confidence/price vote gates, so the
 *   training set sees the full triggered distribution, not just emitted votes (avoids
 *   selection bias that would make the meta-model blind to filtered setups).
 * - evidence_source is explicit and mandatory: PAPER / BACKTEST / REPLAY / LIVE labels
 *   must NEVER be mixed in training. Organic paper labels are the gold standard.
 * - schema_version versions the feature set; when features change, bump it and train
 *   only on rows with a consistent version.
 * - Fail-closed: a logging failure logs and never throws, never blocks the vote path.
 * - NO meta-model is built or activated here. This is training-data capture only.
 */

import crypto from 'crypto';
import { db } from '../db';
import { metaLabelFeatures } from '../db/schema';
import { sql } from 'drizzle-orm';

/** Feature schema version. Bump when the captured feature set changes. */
export const META_LABEL_SCHEMA_VERSION = 1;

export type MetaLabelEvidenceSource = 'PAPER' | 'BACKTEST' | 'REPLAY' | 'LIVE';

export interface MetaLabelFeatureInput {
  /**
   * Join key to agent_predictions.traceId (populated by ReflectionEngine from the
   * TRADE_IDEA_GENERATED event). Generated at trigger time, before emission, so
   * features and the eventual prediction row share it. Null for sub-threshold
   * triggers that never emit (no outcome will ever join - correct).
   */
  traceId: string | null;
  strategyId: string;
  symbol: string;
  signalScore: number | null;
  signalConfidence: number | null;
  regime: string | null;
  decisionPrice: number | null;
  barCount: number | null;
  conditionsMet: string[];
  conditionsFailed: string[];
  evidenceSource: MetaLabelEvidenceSource;
  featureTimestamp?: string;
}

/** Record a feature snapshot for a triggered setup. Fail-closed: logs, never throws. */
export function recordMetaLabelFeatures(input: MetaLabelFeatureInput): void {
  try {
    db.insert(metaLabelFeatures).values({
      id: crypto.randomUUID(),
      traceId: input.traceId,
      strategyId: input.strategyId,
      symbol: input.symbol,
      signalScore: input.signalScore,
      signalConfidence: input.signalConfidence,
      regime: input.regime,
      decisionPrice: input.decisionPrice,
      barCount: input.barCount,
      conditionsMet: JSON.stringify(input.conditionsMet ?? []),
      conditionsFailed: JSON.stringify(input.conditionsFailed ?? []),
      featureTimestamp: input.featureTimestamp ?? new Date().toISOString(),
      schemaVersion: META_LABEL_SCHEMA_VERSION,
      evidenceSource: input.evidenceSource,
      createdAt: new Date().toISOString(),
    }).run();
  } catch (e) {
    console.error('[MetaLabelStore] Failed to record features', e);
  }
}

/**
 * Count labeled training rows available for a strategy and evidence source.
 * A row is "labeled" when its traceId joins to a graded agent_predictions row
 * (via predictionOutcomes, excluding N_A). Used to decide when sufficient real
 * labels exist to even consider training a meta-model.
 */
export function countLabeledRows(strategyId: string, evidenceSource: MetaLabelEvidenceSource): number {
  try {
    const rows = db.all(sql`
      SELECT COUNT(*) as n FROM meta_label_features f
      JOIN agent_predictions p ON p.trace_id = f.trace_id
      JOIN prediction_outcomes o ON o.prediction_id = p.id
      WHERE f.strategy_id = ${strategyId} AND f.evidence_source = ${evidenceSource}
        AND f.schema_version = ${META_LABEL_SCHEMA_VERSION} AND f.trace_id IS NOT NULL
        AND o.outcome != 'N_A' AND o.source_table = 'agent_predictions'
    `) as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  } catch (e) {
    console.error('[MetaLabelStore] Failed to count labeled rows', e);
    return 0;
  }
}
