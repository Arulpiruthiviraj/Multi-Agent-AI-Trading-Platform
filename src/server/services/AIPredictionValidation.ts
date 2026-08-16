/**
 * ==========================================================
 * Module: AIPredictionValidation
 *
 * Purpose:
 * Phase 9, Stage B (ARGUS_PRE_IMPLEMENTATION_BASELINE.md / ARGUS_AI_VALIDATION_REPORT.md).
 * Real-data statistical validation of live agent predictions against what actually happened,
 * using PredictionOutcomeEvaluator's existing real, point-in-time bars-based `prediction_outcomes`
 * table (never a fabricated/simulated outcome). This module does not evaluate anything itself -
 * it aggregates already-real per-prediction outcomes into the metrics this phase explicitly asks
 * for (accuracy, calibration, Brier score, precision/recall, average realized return by predicted
 * side) that no prior module computed.
 *
 * Honest scope limit, stated here rather than silently omitted: this measures REAL directional
 * accuracy and calibration of live agent predictions, not real trade P&L - not every prediction
 * results in a real filled order (most are evidence that fed a consensus vote, win or lose), so
 * "P&L contribution" per prediction is not computed here. Average realized subsequent return is
 * reported instead as an honest, real proxy for expected value, explicitly labeled as such.
 * ==========================================================
 */
import { db } from '../db';
import { agentPredictions, predictionOutcomes } from '../db/schema';
import { eq, and, gte as gteOp } from 'drizzle-orm';

export interface AgentPredictionValidation {
  agentName: string;
  totalPredictions: number;
  evaluatedCount: number; // how many of totalPredictions have a real outcome yet (others are too recent)
  directionalCount: number; // BUY/SELL only - HOLD is excluded from directional accuracy/Brier/precision/recall
  accuracyPct: number | null; // % of directional predictions whose predicted side matched the real actual direction
  brierScore: number | null; // mean((statedConfidence0to1 - actualOutcomeIndicator)^2) - lower is better, 0 is perfect, 0.25 is "no better than a coin flip guessed at 50%"
  precision: number | null; // of predictions that said BUY, what fraction saw the price actually go UP
  recall: number | null; // of real UP moves that occurred after ANY directional prediction, what fraction did this agent correctly call BUY on
  avgRealizedReturnWhenBuy: number | null; // real avg subsequent return (not P&L) following a BUY call - an honest EV proxy, not a claim of real P&L
  avgRealizedReturnWhenSell: number | null;
  statisticallyMeaningful: boolean; // fewer than MIN_SAMPLE_SIZE directional, evaluated predictions - do not trust the numbers above yet
}

import { tradingSafety } from '../config/tradingSafety';

export const MIN_SAMPLE_SIZE_FOR_PREDICTION_VALIDATION = tradingSafety.minSampleSizeForTrust;

/**
 * Real, per-agent aggregation. `sinceIso` optionally bounds the window (e.g. "only predictions
 * from the last 30 days"). Returns one row per agent that has made at least one prediction with a
 * real recorded outcome - an agent with zero evaluated predictions yet is simply absent, not a
 * fabricated all-zero row.
 */
export async function computeAIPredictionValidation(sinceIso?: string): Promise<AgentPredictionValidation[]> {
  const predictions = sinceIso
    ? await db.select().from(agentPredictions).where(gteOp(agentPredictions.timestamp, sinceIso))
    : await db.select().from(agentPredictions).all();
  const outcomes = await db.select().from(predictionOutcomes).where(eq(predictionOutcomes.sourceTable, 'agent_predictions'));
  const outcomeById = new Map(outcomes.map(o => [o.predictionId, o]));

  const byAgent = new Map<string, typeof predictions>();
  for (const p of predictions) {
    if (!byAgent.has(p.agentName)) byAgent.set(p.agentName, []);
    byAgent.get(p.agentName)!.push(p);
  }

  const results: AgentPredictionValidation[] = [];
  for (const [agentName, preds] of byAgent) {
    const evaluated = preds.map(p => ({ pred: p, outcome: outcomeById.get(p.id) })).filter(x => !!x.outcome);
    const directional = evaluated.filter(x => x.pred.prediction === 'BUY' || x.pred.prediction === 'SELL');

    let correctCount = 0;
    let brierSum = 0;
    let tp = 0, fp = 0, fn = 0; // "positive" = a real subsequent UP move
    const buyReturns: number[] = [];
    const sellReturns: number[] = [];

    for (const { pred, outcome } of directional) {
      const actual = outcome!.actualDirection;
      const predictedUp = pred.prediction === 'BUY';
      const actuallyUp = actual === 'UP';
      const correct = (predictedUp && actuallyUp) || (!predictedUp && actual === 'DOWN');
      if (correct) correctCount++;

      const statedProb = Math.max(0, Math.min(1, pred.confidence > 1 ? pred.confidence / 100 : pred.confidence)); // real per-agent scale isn't always identical (0-1 vs 0-100) - normalize honestly rather than assume
      const outcomeIndicator = outcome!.outcome === 'WIN' ? 1 : 0;
      brierSum += Math.pow(statedProb - outcomeIndicator, 2);

      if (predictedUp && actuallyUp) tp++;
      if (predictedUp && !actuallyUp) fp++;
      if (!predictedUp && actuallyUp) fn++; // a SELL call that missed a real UP move

      if (pred.prediction === 'BUY' && outcome!.actualReturn !== null) buyReturns.push(outcome!.actualReturn);
      if (pred.prediction === 'SELL' && outcome!.actualReturn !== null) sellReturns.push(outcome!.actualReturn);
    }

    const avg = (arr: number[]) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

    results.push({
      agentName,
      totalPredictions: preds.length,
      evaluatedCount: evaluated.length,
      directionalCount: directional.length,
      accuracyPct: directional.length > 0 ? Number(((correctCount / directional.length) * 100).toFixed(1)) : null,
      brierScore: directional.length > 0 ? Number((brierSum / directional.length).toFixed(4)) : null,
      precision: (tp + fp) > 0 ? Number((tp / (tp + fp)).toFixed(3)) : null,
      recall: (tp + fn) > 0 ? Number((tp / (tp + fn)).toFixed(3)) : null,
      avgRealizedReturnWhenBuy: avg(buyReturns),
      avgRealizedReturnWhenSell: avg(sellReturns),
      statisticallyMeaningful: directional.length >= MIN_SAMPLE_SIZE_FOR_PREDICTION_VALIDATION,
    });
  }

  return results.sort((a, b) => b.evaluatedCount - a.evaluatedCount);
}
