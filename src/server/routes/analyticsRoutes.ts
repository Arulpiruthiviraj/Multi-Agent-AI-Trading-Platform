/**
 * ==========================================================
 * Module: analyticsRoutes
 *
 * Purpose:
 * Phase 6 of TRANSACTION_OBSERVATORY_ARCHITECTURE.md - agent/model scorecards (accuracy,
 * confidence calibration, latency, cost) computed from real rows only: `agent_predictions`
 * joined to `prediction_outcomes` (via PredictionOutcomeEvaluator's real point-in-time bars),
 * and `ai_calls` for latency/cost. An agent with zero evaluated predictions reports
 * accuracy/calibration as null - never a fabricated number from an empty sample.
 * ==========================================================
 */
import { Router } from 'express';
import { db } from '../db';
import { agentPredictions, predictionOutcomes, aiCalls } from '../db/schema';
import { eq } from 'drizzle-orm';

export const analyticsRouter = Router();

const CALIBRATION_BUCKETS = [
  { label: '50-60%', min: 0.5, max: 0.6 },
  { label: '60-70%', min: 0.6, max: 0.7 },
  { label: '70-80%', min: 0.7, max: 0.8 },
  { label: '80-90%', min: 0.8, max: 0.9 },
  { label: '90-100%', min: 0.9, max: 1.01 },
];

analyticsRouter.get('/scorecards', async (req, res) => {
  try {
    const predictions = await db.select().from(agentPredictions);
    const outcomes = await db.select().from(predictionOutcomes).where(eq(predictionOutcomes.sourceTable, 'agent_predictions'));
    const calls = await db.select().from(aiCalls);

    const outcomeByPredictionId = new Map(outcomes.map(o => [o.predictionId, o]));
    const agents = new Set(predictions.map(p => p.agentName));

    const scorecards = Array.from(agents).map(agentName => {
      const agentPreds = predictions.filter(p => p.agentName === agentName);
      const evaluated = agentPreds
        .map(p => ({ prediction: p, outcome: outcomeByPredictionId.get(p.id) }))
        .filter((x): x is { prediction: typeof agentPreds[0]; outcome: NonNullable<typeof x.outcome> } => !!x.outcome && x.outcome.outcome !== 'N_A');

      const correct = evaluated.filter(x => x.outcome.outcome === 'WIN').length;
      const accuracy = evaluated.length > 0 ? correct / evaluated.length : null;
      const avgConfidence = agentPreds.length > 0 ? agentPreds.reduce((s, p) => s + p.confidence, 0) / agentPreds.length : null;

      const calibration = CALIBRATION_BUCKETS.map(bucket => {
        const inBucket = evaluated.filter(x => x.prediction.confidence >= bucket.min && x.prediction.confidence < bucket.max);
        const bucketCorrect = inBucket.filter(x => x.outcome.outcome === 'WIN').length;
        return {
          range: bucket.label,
          count: inBucket.length,
          statedConfidence: inBucket.length > 0 ? inBucket.reduce((s, x) => s + x.prediction.confidence, 0) / inBucket.length : null,
          actualAccuracy: inBucket.length > 0 ? bucketCorrect / inBucket.length : null,
        };
      }).filter(b => b.count > 0); // only report buckets with real samples - never a fabricated empty bucket

      const agentCalls = calls.filter(c => c.agent === agentName);
      const avgLatencyMs = agentCalls.length > 0 ? agentCalls.reduce((s, c) => s + (c.latencyMs || 0), 0) / agentCalls.length : null;
      const totalCost = agentCalls.length > 0 ? agentCalls.reduce((s, c) => s + (c.cost || 0), 0) : null;

      return {
        agent: agentName,
        totalPredictions: agentPreds.length,
        evaluatedPredictions: evaluated.length,
        correctPredictions: correct,
        accuracy,
        avgConfidence,
        calibration,
        aiCallCount: agentCalls.length,
        avgLatencyMs,
        totalCost,
      };
    });

    res.json({ ok: true, scorecards });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
