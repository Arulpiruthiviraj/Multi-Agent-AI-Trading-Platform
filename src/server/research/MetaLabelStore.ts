/**
 * MetaLabelStore.ts
 * ============================================================================
 * WHAT: Training-data capture for the meta-labeling ML architecture.
 * WHERE IN THE ARCHITECTURE: This is the data-collection half of a supervised
 *   learning pipeline that does not yet exist:
 *
 *     Strategy triggers (Java) → [this module: feature snapshot]
 *                                           ↓
 *                              meta_label_features table
 *                                           ↓  (JOIN on trace_id)
 *                              agent_predictions → prediction_outcomes
 *                                           ↓
 *                              LABELED TRAINING ROWS (features → realized P&L)
 *                                           ↓  (future, not built)
 *                              Meta-model: P(profitable | features)
 *                                           ↓  (future, not built)
 *                              MetaLabelSizing.size(p) → position scale
 *
 * THE QUANT CASE FOR META-LABELING (Marcos López de Prado, 2018):
 *   A primary strategy (e.g., 12-month time-series momentum) makes a directional
 *   bet: "go long." But not all triggered setups are equal — some occur in
 *   favorable regimes with strong confirmation, others are marginal triggers
 *   that barely cross the threshold. The primary model's binary trigger discards
 *   this information.
 *
 *   Meta-labeling trains a SECONDARY model on a different question: "given that
 *   the primary strategy triggered, will this specific setup make money after
 *   costs?" The primary model decides SIDE (long/short); the meta-model decides
 *   SIZE (how much to bet, including zero). This decomposition is powerful
 *   because:
 *   - The meta-model can use features the primary model doesn't see (regime,
 *     volatility context, time-of-day, recent strategy hit rate).
 *   - It directly optimizes the trading objective (profitability) rather than
 *     a proxy (signal strength).
 *   - A well-calibrated meta-model enables the S-curve sizing: bet proportional
 *     to edge, not binary all-or-nothing.
 *
 *   The critical requirement — and the reason this module exists — is LABELED
 *   DATA. The meta-model needs thousands of examples of (setup features →
 *   realized outcome). There is no shortcut: you cannot train it on backtest
 *   PnL and expect it to work live (distributional shift), and you cannot
 *   invent labels. This module starts the clock on accumulating real ones.
 *
 * WHY CAPTURE BEFORE THE VOTE GATES (the selection-bias argument):
 *   The vote service applies gates AFTER trigger: confidence ≥ 0.6, valid price,
 *   agent enabled, etc. If we only captured features for EMITTED votes, the
 *   training set would be conditioned on "passed all gates" — the meta-model
 *   would never see what a filtered-out setup looks like, and couldn't learn
 *   the boundary between "good trigger" and "bad trigger." By capturing at
 *   triggerMet=true (before gating), the training distribution matches the
 *   deployment distribution: every setup the strategy produces, labeled by
 *   what actually happened.
 *
 *   Setups that don't emit votes get traceId values that never join to a
 *   prediction row — they contribute to distributional understanding but not
 *   to supervised training. This is correct, not a bug.
 *
 * WHY trace_id AS THE JOIN KEY (not prediction_id):
 *   At capture time, the prediction row doesn't exist yet — ReflectionEngine
 *   creates it asynchronously when it processes the TRADE_IDEA_GENERATED event.
 *   But the traceId IS known at capture time (we generate it before emitting).
 *   By threading the same traceId through both the feature row and the emitted
 *   vote, we create a deterministic join key without temporal coupling:
 *     features.trace_id → agent_predictions.trace_id → prediction_outcomes
 *   This avoids the race condition of "insert feature, then look up the
 *   prediction ID that doesn't exist yet."
 *
 * EVIDENCE SOURCE DISCIPLINE:
 *   The evidence_source column (PAPER | BACKTEST | REPLAY | LIVE) is mandatory
 *   because these label sources have fundamentally different statistical
 *   properties:
 *   - PAPER: real market impact (or lack thereof), real slippage, real timing.
 *     Gold standard. Slow to accumulate.
 *   - BACKTEST: no market impact, idealized fills, lookahead-bias risk.
 *     Fast to accumulate, optimistic bias.
 *   - REPLAY: historical simulation with realistic engine behavior. Better than
 *     backtest, worse than paper.
 *   - LIVE: real money. The ultimate label, but we don't trade live.
 *   Mixing them in training would let the model learn artifacts of the
 *   simulation rather than the market. The countLabeledRows() gate enforces
 *   per-source counting so a training job can require "≥N PAPER labels"
 *   without BACKTEST rows inflating the count.
 *
 * SCHEMA VERSIONING:
 *   When the feature set changes (new features added, old ones removed or
 *   redefined), META_LABEL_SCHEMA_VERSION increments. Training must filter to
 *   a single version — mixing v1 rows (10 features) with v2 rows (14 features)
 *   would create phantom missing-values that corrupt the model. Old rows are
 *   never migrated or deleted; they're just excluded from training.
 *
 * FAIL-CLOSED CONTRACT:
 *   This module sits in the hot path of vote emission (called synchronously
 *   from emitVoteIfEligible). A failure here — DB locked, disk full, schema
 *   mismatch — must NEVER block or break the vote. Both exported functions
 *   catch all exceptions, log, and return safe defaults (void / 0).
 *   Losing a feature row is regrettable; blocking a trade vote is unacceptable.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *   - No model training, no inference, no calibration. Those belong in the
 *     Java quant core (per the Engine Authority rule) when the time comes.
 *   - No feature engineering beyond snapshotting. The features captured are
 *     raw signals; transformations (z-scores, interactions, embeddings) are
 *     the model-training pipeline's job.
 *   - No outcome computation. PredictionOutcomeEvaluator already grades
 *     predictions on its own horizon; we reuse it rather than building a
 *     parallel grading system.
 */

import crypto from 'crypto';
import { db } from '../db';
import { metaLabelFeatures } from '../db/schema';
import { sql } from 'drizzle-orm';

/**
 * Feature schema version. Increment when the captured feature set changes
 * in any way (add, remove, or redefine a feature). Training jobs MUST filter
 * to a single version — see the header comment for why mixing is invalid.
 */
export const META_LABEL_SCHEMA_VERSION = 1;

/**
 * Provenance label for every captured feature row.
 * NEVER mix sources in a single training set — see header comment.
 */
export type MetaLabelEvidenceSource = 'PAPER' | 'BACKTEST' | 'REPLAY' | 'LIVE';

export interface MetaLabelFeatureInput {
  /**
   * Join key to agent_predictions.trace_id (populated by ReflectionEngine from
   * the TRADE_IDEA_GENERATED event). Generated at trigger time, before emission,
   * so features and the eventual prediction row share it deterministically.
   * Null for sub-threshold triggers that never emit — these rows will never
   * join to an outcome, which is correct (no label exists for them).
   */
  traceId: string | null;
  /** Java strategy ID, e.g. 'INSTITUTIONAL_TS_MOMENTUM_12M'. Labels are per-strategy. */
  strategyId: string;
  symbol: string;
  /**
   * The strategy's raw setup score at trigger time (0-100 scale for most
   * strategies). Distinct from confidence: score measures signal strength,
   * confidence measures the strategy's self-assessed reliability. The
   * meta-model may learn they have different predictive power.
   */
  signalScore: number | null;
  /** The strategy's stated confidence (0-1). Used to detect overconfidence. */
  signalConfidence: number | null;
  /**
   * Deterministic regime label at signal time (e.g., 'BULLISH_TREND',
   * 'HIGH_VOL_RANGING'). From RegimeEngine.classifyRegime — the rule-based
   * classifier, not the LLM one, so it's reproducible and free. Regime is
   * among the most informative meta-features: momentum strategies behave
   * very differently in trending vs. ranging markets.
   */
  regime: string | null;
  /**
   * The last close price when the signal was evaluated (arrival price).
   * Combined with the eventual fill price (from predictionOutcomes), this
   * lets the training pipeline compute implementation shortfall —
   * a key component of "profitable after costs."
   */
  decisionPrice: number | null;
  /** How many bars the strategy evaluated. Proxy for signal maturity. */
  barCount: number | null;
  /**
   * Which named conditions passed/failed (e.g., ['trend_up', 'vol_ok']).
   * Stored as JSON arrays. These are the strategy's own diagnostic labels —
   * the meta-model can learn that certain condition combinations are
   * historically profitable while others are coin flips.
   */
  conditionsMet: string[];
  conditionsFailed: string[];
  evidenceSource: MetaLabelEvidenceSource;
  featureTimestamp?: string;
}

/**
 * Persist a feature snapshot for one triggered setup.
 *
 * Called synchronously from the vote path — hence the fail-closed contract:
 * any exception is caught, logged, and swallowed. The insert uses a random
 * UUID primary key (not trace_id) because one trigger produces exactly one
 * feature row, and UUIDs avoid any coupling to the traceId generation scheme.
 */
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
 * Count how many LABELED training rows exist for a strategy + evidence source.
 *
 * A row is "labeled" iff:
 *   1. Its trace_id joins to an agent_predictions row (the vote was emitted
 *      and recorded — sub-threshold triggers never satisfy this), AND
 *   2. That prediction has a prediction_outcomes row with a definitive
 *      WIN/LOSS (N_A = not yet graded or ungradeable — excluded, never
 *      counted as a loss), AND
 *   3. The feature row's schema version matches current (no cross-version
 *      contamination), AND
 *   4. The evidence source matches exactly (no PAPER/BACKTEST mixing).
 *
 * This is the GATE for meta-model training: a future training job should
 * require countLabeledRows(strategy, 'PAPER') >= MIN_LABELS before even
 * attempting to fit. The threshold itself (likely 200-500 for a simple
 * logistic model) is a research decision, not hardcoded here.
 *
 * Returns 0 on any failure (fail-closed: "no labels" is always a safe answer;
 * it just means "don't train yet").
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
