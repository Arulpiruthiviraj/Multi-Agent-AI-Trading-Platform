/**
 * ==========================================================
 * Module: TrainingExampleBuilder
 *
 * Purpose:
 * Phase 7 of TRANSACTION_OBSERVATORY_ARCHITECTURE.md. Materializes `training_examples` rows
 * from completed transactions - batch-built, never written live, per the doc's explicit "do not
 * automatically train models yet" scope. Nothing here trains anything; this only assembles the
 * dataset a future training pipeline could consume.
 *
 * Point-in-time integrity (req #24) is a hard check, not a convention: for every transaction
 * considered, every contributing agent's own prediction timestamp (`availableAt`) is checked
 * against the consensus decision timestamp (`decisionAt`). A transaction where any contributing
 * evidence's timestamp is AFTER the decision it fed - which should never happen given real
 * causality, but is exactly the bug this check exists to catch - is skipped and logged, never
 * silently included.
 *
 * The label reuses PredictionOutcomeEvaluator's real point-in-time-bars evaluation (the same
 * mechanism Phase 4 uses for individual predictions) against the transaction's own final
 * decision, rather than building a second evaluation mechanism.
 * ==========================================================
 */
import { db } from '../db';
import { transactions, consensusDecisions, consensusEvidence, agentPredictions, trainingExamples } from '../db/schema';
import { eq } from 'drizzle-orm';
import { evaluatePrediction, EVALUATION_HORIZON_MS } from './PredictionOutcomeEvaluator';
import { tradingSafety } from '../config/tradingSafety';

export class TrainingExampleBuilder {
  private intervalId: NodeJS.Timeout | null = null;

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.buildPending().catch(e => console.error('[TrainingExampleBuilder] Cycle failed', e)), tradingSafety.trainingExampleIntervalMs);
    this.buildPending().catch(e => console.error('[TrainingExampleBuilder] Initial cycle failed', e));
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async buildPending() {
    const now = Date.now();
    const existing = await db.select().from(trainingExamples);
    const existingIds = new Set(existing.map(t => t.transactionId));

    const txns = await db.select().from(transactions);
    for (const txn of txns) {
      if (existingIds.has(txn.id)) continue;
      if (!txn.finalDecision) continue; // NO_CONSENSUS transactions have no decision to label

      const decision = await db.select().from(consensusDecisions).where(eq(consensusDecisions.transactionId, txn.id)).get();
      if (!decision) continue;

      const decisionAtMs = new Date(decision.createdAt).getTime();
      if (now - decisionAtMs < EVALUATION_HORIZON_MS) continue; // not old enough for a real outcome yet

      const evidenceRows = await db.select().from(consensusEvidence).where(eq(consensusEvidence.transactionId, txn.id));

      // Point-in-time leakage check: every contributing agent's own prediction timestamp must
      // be at or before the moment consensus was decided.
      let leakageDetected = false;
      const evidenceWithTimestamps: { agent: string; side: string; confidence: number; weight: number; availableAt: string }[] = [];
      for (const e of evidenceRows) {
        if (!e.sourceTraceId) continue;
        const pred = await db.select().from(agentPredictions).where(eq(agentPredictions.traceId, e.sourceTraceId)).get();
        if (!pred) continue;
        const availableAtMs = new Date(pred.timestamp).getTime();
        if (availableAtMs > decisionAtMs) {
          leakageDetected = true;
        }
        evidenceWithTimestamps.push({ agent: e.agent, side: e.side, confidence: e.confidence, weight: e.weight, availableAt: pred.timestamp });
      }
      if (leakageDetected) {
        console.warn(`[TrainingExampleBuilder] Point-in-time leakage detected for ${txn.id} - at least one contributing prediction's timestamp is after the consensus decision. Skipping, not including.`);
        continue;
      }

      const label = await evaluatePrediction(txn.id, 'transactions', txn.symbol, txn.finalDecision, decisionAtMs);
      if (!label) continue; // no real bars available for this symbol/window - never fabricate a label

      const observedAt = evidenceWithTimestamps.length > 0
        ? evidenceWithTimestamps.reduce((earliest, e) => (e.availableAt < earliest ? e.availableAt : earliest), evidenceWithTimestamps[0].availableAt)
        : decision.createdAt;

      try {
        await db.insert(trainingExamples).values({
          id: txn.id,
          transactionId: txn.id,
          observedAt,
          availableAt: decision.createdAt,
          decisionAt: decision.createdAt,
          featureSnapshot: JSON.stringify({ symbol: txn.symbol, evidence: evidenceWithTimestamps, consensus: decision }),
          label: JSON.stringify(label),
          createdAt: new Date().toISOString(),
        }).onConflictDoNothing();
      } catch (e) {
        console.error('[TrainingExampleBuilder] Failed to persist training example', e);
      }
    }
  }
}

export const trainingExampleBuilder = new TrainingExampleBuilder();
