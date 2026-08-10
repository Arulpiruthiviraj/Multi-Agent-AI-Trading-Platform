import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

/**
 * Real integration test against an isolated temp SQLite DB (not data/argus.db, per CLAUDE.md) -
 * no per-module mocks, since this module's entire value is real DB persistence (transactions,
 * consensus_decisions, consensus_evidence rows) and the daily-counter minting logic. Same
 * pattern as marketDataToRisk.test.ts.
 */
describe('TransactionRegistry.recordConsensusTransaction', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let recordConsensusTransaction: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_txregistry_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ recordConsensusTransaction } = await import('./TransactionRegistry'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('mints an ARG-YYYY-MM-DD-NNNNNN id and persists a transaction + consensus_decisions row on approval', async () => {
    const id = await recordConsensusTransaction({
      symbol: 'AAPL',
      side: 'BUY',
      weightedConfidence: 0.81,
      threshold: 0.75,
      approved: true,
      reasoning: 'strong agreement',
      evidence: [
        { sourceTraceId: 't1', agent: 'TechnicalAgent', side: 'BUY', confidence: 0.9, weight: 0.25, reasoning: 'momentum' },
        { sourceTraceId: 't2', agent: 'NewsAgent', side: 'SELL', confidence: 0.3, weight: 0.25, reasoning: 'weak bearish' },
      ],
    });

    const today = new Date().toISOString().slice(0, 10);
    expect(id).toMatch(new RegExp(`^ARG-${today}-\\d{6}$`));

    const [txn] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, id));
    expect(txn.status).toBe('OPEN');
    expect(txn.finalDecision).toBe('BUY');
    expect(txn.outcome).toBe('PENDING');
    expect(txn.closedAt).toBeNull();

    const [decision] = await db.select().from(schema.consensusDecisions).where(eq(schema.consensusDecisions.transactionId, id));
    expect(decision.approved).toBe(true);
    expect(decision.agreementsCount).toBe(1);
    expect(decision.disagreementsCount).toBe(1);

    const evidenceRows = await db.select().from(schema.consensusEvidence).where(eq(schema.consensusEvidence.transactionId, id));
    expect(evidenceRows).toHaveLength(2);
    const technical = evidenceRows.find((e: any) => e.agent === 'TechnicalAgent');
    const news = evidenceRows.find((e: any) => e.agent === 'NewsAgent');
    // consensus_evidence must correctly link EVERY contributing agent's evidence to the ONE
    // canonical transaction id, regardless of each agent's own different sourceTraceId - this is
    // the fix for the bug where only one arbitrary agent's traceId survived downstream.
    expect(technical.sourceTraceId).toBe('t1');
    expect(technical.agreed).toBe(true);
    expect(news.sourceTraceId).toBe('t2');
    expect(news.agreed).toBe(false);
  });

  it('records a NO_CONSENSUS transaction (approved=false) as immediately closed with outcome N_A', async () => {
    const id = await recordConsensusTransaction({
      symbol: 'TSLA',
      side: 'BUY',
      weightedConfidence: 0.6,
      threshold: 0.75,
      approved: false,
      reasoning: 'window closed without consensus',
      evidence: [
        { sourceTraceId: 't3', agent: 'TechnicalAgent', side: 'BUY', confidence: 0.6, weight: 0.25, reasoning: 'weak momentum' },
      ],
    });

    const [txn] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, id));
    expect(txn.status).toBe('NO_CONSENSUS');
    expect(txn.finalDecision).toBeNull();
    expect(txn.outcome).toBe('N_A');
    expect(txn.closedAt).not.toBeNull();

    const [decision] = await db.select().from(schema.consensusDecisions).where(eq(schema.consensusDecisions.transactionId, id));
    expect(decision.approved).toBe(false);
  });

  it('mints strictly increasing, unique ids across repeated calls on the same day', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const id = await recordConsensusTransaction({
        symbol: 'MSFT', side: 'HOLD', weightedConfidence: 0.1, threshold: 0.75, approved: false,
        evidence: [],
      });
      ids.add(id);
    }
    expect(ids.size).toBe(5);
  });

  it('handles zero-evidence consensus (no consensus_evidence rows inserted, no crash)', async () => {
    const id = await recordConsensusTransaction({
      symbol: 'NVDA', side: 'HOLD', weightedConfidence: 0, threshold: 0.75, approved: false,
      evidence: [],
    });
    const evidenceRows = await db.select().from(schema.consensusEvidence).where(eq(schema.consensusEvidence.transactionId, id));
    expect(evidenceRows).toHaveLength(0);
  });
});
