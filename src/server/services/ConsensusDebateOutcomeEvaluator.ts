/**
 * ==========================================================
 * Module: ConsensusDebateOutcomeEvaluator
 *
 * ConsensusDebate P0.5 forensic measurement (2026-09-13) - grades each VALID_PREDICTION
 * consensus_debate_predictions row against real forward price action, answering "would the
 * underlying (non-debate) candidate have won or lost." Reuses the EXISTING, already-real
 * evaluatePrediction() from PredictionOutcomeEvaluator.ts (same real-bars WIN/LOSS/MFE/MAE math
 * every other prediction in this codebase is graded with) rather than a fourth parallel grading
 * mechanism, and persists into the SAME shared prediction_outcomes table
 * (sourceTable = 'consensus_debate_predictions') - never a new grading table.
 *
 * Grades baseConsensusSide (what the non-debate agents concluded), not debateDirection - the
 * economic question this whole measurement exists to answer is "did ConsensusDebate's veto
 * prevent a winner or a loser," which requires grading the candidate it vetoed, not grading
 * ConsensusDebate's own HOLD "call" (which evaluatePrediction() would just report as N_A anyway).
 *
 * FAIL_CLOSED_* rows are never graded - AI reliability events are not predictions (mandate
 * requirement: "Only VALID_PREDICTION is eligible for performance grading").
 * ==========================================================
 */
import { db } from '../db';
import { consensusDebatePredictions, predictionOutcomes } from '../db/schema';
import { eq } from 'drizzle-orm';
import { evaluatePrediction } from './PredictionOutcomeEvaluator';
import { tradingSafety } from '../config/tradingSafety';

const CONSENSUS_DEBATE_SOURCE_TABLE = 'consensus_debate_predictions';

export class ConsensusDebateOutcomeEvaluator {
  private intervalId: NodeJS.Timeout | null = null;

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(
      () => this.evaluatePending().catch((e) => console.error('[ConsensusDebateOutcomeEvaluator] Cycle failed', e)),
      tradingSafety.predictionOutcomeIntervalMs,
    );
    this.evaluatePending().catch((e) => console.error('[ConsensusDebateOutcomeEvaluator] Initial cycle failed', e));
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async evaluatePending() {
    const now = Date.now();
    const existing = await db.select().from(predictionOutcomes)
      .where(eq(predictionOutcomes.sourceTable, CONSENSUS_DEBATE_SOURCE_TABLE));
    const evaluatedIds = new Set(existing.map((o) => o.predictionId));

    const rows = await db.select().from(consensusDebatePredictions)
      .where(eq(consensusDebatePredictions.debateStatus, 'VALID_PREDICTION'));

    for (const row of rows) {
      if (evaluatedIds.has(row.id)) continue;
      const predTime = new Date(row.createdAt).getTime();
      if (now - predTime < tradingSafety.evaluationHorizonMs) continue;

      const result = await evaluatePrediction(
        row.id, CONSENSUS_DEBATE_SOURCE_TABLE, row.symbol, row.baseConsensusSide, predTime, tradingSafety.evaluationHorizonMs,
      );
      if (result) {
        try {
          await db.insert(predictionOutcomes).values(result).onConflictDoNothing();
        } catch (e) {
          console.error('[ConsensusDebateOutcomeEvaluator] Failed to persist outcome', e);
        }
      }
    }
  }
}

export const consensusDebateOutcomeEvaluator = new ConsensusDebateOutcomeEvaluator();
