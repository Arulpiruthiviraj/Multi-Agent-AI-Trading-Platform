/**
 * Tests for the 4 retention sweepers added by the 2026-10-10 defect hunt (Track 1,
 * soak-path retention). A 180-sim-minute SOAK_3H synthetic session wrote rows to
 * consensus_debate_predictions (27), consensus_decisions (8), consensus_evidence (10)
 * and reconciliation_events (1) with no prune path anywhere in the codebase - the same
 * defect class as candidate_rankings (2026-09-22) and news_articles (2026-10-08).
 *
 * These tests prove per-table cutoff semantics (old pruned, recent kept), idempotency,
 * the consensus_evidence join semantics (pruned via the parent consensus_decisions row,
 * which is written in the SAME transaction - TransactionRegistry - plus orphan cleanup
 * for sweep-ordering artifacts), and that a large backlog does NOT block the event loop
 * (batched + yielding: a heartbeat scheduled with setImmediate must tick while the sweep
 * works through multiple batches). Same isolation pattern as newsRetention.test.ts:
 * ARGUS_DB_PATH points at a temp SQLite file; migrations run on import.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('soak-path retention sweeps (2026-10-10 defect hunt)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let sweepConsensusDebatePredictionsRetention: (nowMs?: number) => Promise<number>;
  let sweepConsensusDecisionsRetention: (nowMs?: number) => Promise<number>;
  let sweepConsensusEvidenceRetention: (nowMs?: number) => Promise<number>;
  let sweepReconciliationEventsRetention: (nowMs?: number) => Promise<number>;
  let intervals: any;

  const daysAgoIso = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const uid = () => `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_soakpath_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ sqliteDb } = await import('../db/index'));
    ({
      sweepConsensusDebatePredictionsRetention,
      sweepConsensusDecisionsRetention,
      sweepConsensusEvidenceRetention,
      sweepReconciliationEventsRetention,
    } = await import('./operationalRetention'));
    ({ runtimeIntervals: intervals } = await import('../config/runtimeIntervals'));
  });

  afterAll(() => {
    try { fs.unlinkSync(tmpDbPath); } catch { /* best effort */ }
    delete process.env.ARGUS_DB_PATH;
  });

  // Tables are shared across tests in this file; clear them before each test so
  // row counts stay independent (a prior test's surviving rows must not leak in).
  beforeEach(() => {
    for (const t of ['consensus_debate_predictions', 'consensus_decisions', 'consensus_evidence', 'reconciliation_events']) {
      sqliteDb.prepare(`DELETE FROM ${t}`).run();
    }
  });

  function insertDebatePrediction(id: string, createdAtIso: string) {
    sqliteDb.prepare(
      `INSERT INTO consensus_debate_predictions
         (id, trace_id, symbol, created_at, debate_status, providers_attempted,
          providers_succeeded, providers_failed, underlying_agent_count,
          underlying_evidence_json, base_consensus_side, base_consensus_confidence,
          base_clears_threshold, base_clears_independence,
          with_debate_consensus_side, with_debate_consensus_confidence,
          with_debate_approved, veto_fired)
       VALUES (?, ?, 'TST', ?, 'VALID_PREDICTION', 0, 0, 0, 2, '[]',
               'BUY', 0.8, 1, 1, 'BUY', 0.8, 1, 0)`
    ).run(id, `trace-${id}`, createdAtIso);
  }

  function insertDecision(transactionId: string, createdAtIso: string) {
    sqliteDb.prepare(
      `INSERT INTO consensus_decisions
         (transaction_id, symbol, side, weighted_confidence, threshold, approved, created_at)
       VALUES (?, 'TST', 'BUY', 0.8, 0.75, 1, ?)`
    ).run(transactionId, createdAtIso);
  }

  function insertEvidence(transactionId: string) {
    sqliteDb.prepare(
      `INSERT INTO consensus_evidence
         (transaction_id, agent, side, confidence, weight, agreed)
       VALUES (?, 'TechnicalAgent', 'BUY', 0.8, 1.0, 1)`
    ).run(transactionId);
  }

  function insertReconciliationEvent(checkedAtIso: string) {
    sqliteDb.prepare(
      `INSERT INTO reconciliation_events (checked_at, broker, matches)
       VALUES (?, 'internal_paper', 1)`
    ).run(checkedAtIso);
  }

  function count(table: string): number {
    return (sqliteDb.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  }

  it('consensus_debate_predictions: prunes old rows, keeps recent, idempotent', async () => {
    const days = intervals.consensusDebatePredictionsRetentionDays as number;
    insertDebatePrediction(`dp-old-${uid()}`, daysAgoIso(days + 5));
    insertDebatePrediction(`dp-new-${uid()}`, daysAgoIso(1));
    expect(await sweepConsensusDebatePredictionsRetention()).toBe(1);
    expect(count('consensus_debate_predictions')).toBe(1);
    expect(await sweepConsensusDebatePredictionsRetention()).toBe(0);
  });

  it('consensus_decisions: prunes old rows, keeps recent, idempotent', async () => {
    const days = intervals.consensusDecisionsRetentionDays as number;
    insertDecision(`tx-old-${uid()}`, daysAgoIso(days + 5));
    insertDecision(`tx-new-${uid()}`, daysAgoIso(1));
    expect(await sweepConsensusDecisionsRetention()).toBe(1);
    expect(count('consensus_decisions')).toBe(1);
    expect(await sweepConsensusDecisionsRetention()).toBe(0);
  });

  it('consensus_evidence: prunes via parent decision age, keeps evidence of recent decisions', async () => {
    const days = intervals.consensusEvidenceRetentionDays as number;
    const oldTx = `tx-ev-old-${uid()}`;
    const newTx = `tx-ev-new-${uid()}`;
    insertDecision(oldTx, daysAgoIso(days + 5));
    insertDecision(newTx, daysAgoIso(1));
    insertEvidence(oldTx);
    insertEvidence(newTx);
    expect(await sweepConsensusEvidenceRetention()).toBe(1);
    expect(count('consensus_evidence')).toBe(1);
    // The surviving row belongs to the recent decision.
    const remaining = sqliteDb.prepare('SELECT transaction_id FROM consensus_evidence').get() as { transaction_id: string };
    expect(remaining.transaction_id).toBe(newTx);
    expect(await sweepConsensusEvidenceRetention()).toBe(0);
  });

  it('consensus_evidence: prunes orphans whose parent decision was swept first', async () => {
    const days = intervals.consensusEvidenceRetentionDays as number;
    const tx = `tx-orphan-${uid()}`;
    insertDecision(tx, daysAgoIso(days + 5));
    insertEvidence(tx);
    // Sweep decisions first (simulating sweep-ordering in the same cycle).
    expect(await sweepConsensusDecisionsRetention()).toBe(1);
    expect(count('consensus_evidence')).toBe(1); // orphan remains
    // The evidence sweeper must still collect it.
    expect(await sweepConsensusEvidenceRetention()).toBe(1);
    expect(count('consensus_evidence')).toBe(0);
  });

  it('reconciliation_events: prunes old rows, keeps recent, idempotent', async () => {
    const days = intervals.reconciliationEventsRetentionDays as number;
    insertReconciliationEvent(daysAgoIso(days + 5));
    insertReconciliationEvent(daysAgoIso(1));
    expect(await sweepReconciliationEventsRetention()).toBe(1);
    expect(count('reconciliation_events')).toBe(1);
    expect(await sweepReconciliationEventsRetention()).toBe(0);
  });

  it('a large backlog does not block the event loop (batched + yielding)', async () => {
    const days = intervals.consensusDecisionsRetentionDays as number;
    const batchSize = intervals.newsRetentionSweepBatchSize as number;
    // More than one batch of old rows.
    for (let i = 0; i < batchSize + 10; i++) {
      insertDecision(`tx-flood-${uid()}-${i}`, daysAgoIso(days + 5));
    }
    let heartbeats = 0;
    const beat = () => { heartbeats++; setImmediate(beat); };
    const timer = setImmediate(beat);
    try {
      const deleted = await sweepConsensusDecisionsRetention();
      expect(deleted).toBe(batchSize + 10);
      // The sweep yielded between batches: the event loop kept turning.
      expect(heartbeats).toBeGreaterThan(0);
    } finally {
      clearImmediate(timer);
    }
  });

  it('sweepers never throw (return partial count on error)', async () => {
    // Dropping the table simulates a corrupt/missing-table failure; the sweeper
    // must return a partial count, not throw (P2-R4: failures log loudly).
    sqliteDb.prepare('DROP TABLE consensus_debate_predictions').run();
    await expect(sweepConsensusDebatePredictionsRetention()).resolves.toBe(0);
  });
});
