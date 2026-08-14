import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

/**
 * Phase 16A (ARGUS_PHASE16_READINESS_REPORT.md) - real end-to-end regression test for the root
 * cause found while investigating the 141 real transactions permanently stuck in `status: 'OPEN'`
 * despite a real, persisted RiskEngine rejection (see that report's forensics section for the
 * full evidence trail). The root cause was NOT a logic bug in current code - it was a stale,
 * already-running `tsx server.ts` process (no hot-reload) that had TransactionLifecycleTracker's
 * CHIEF_APPROVED_IDEA -> RiskEngine -> RISK_ASSESSMENT_COMPLETED -> transactions.status chain
 * loaded into memory from BEFORE that wiring existed on disk; every transaction minted after the
 * next real restart transitions correctly (142/142 clean in the real DB).
 *
 * This test exists to catch a REAL future regression of the same class: it drives the FULL real
 * listener fan-out (RiskAgent, TradingEngine, EventStore, TransactionLifecycleTracker - the same
 * set SystemBootstrap.ts wires in production) through a real CHIEF_APPROVED_IDEA emission, not a
 * synthetic direct RISK_ASSESSMENT_COMPLETED emit like TransactionLifecycleTracker.test.ts already
 * covers in isolation. If any listener registered ahead of TransactionLifecycleTracker in this
 * chain (EventBus.emit()'s fan-out is Node's plain synchronous EventEmitter - one listener's
 * throw silently prevents every listener registered after it from running for that event) ever
 * starts throwing on a real payload shape, this test fails loudly instead of silently producing
 * another permanently-stuck transaction.
 */
describe('CHIEF_APPROVED_IDEA -> RiskEngine -> transactions.status (Phase 16A regression)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let eventBus: any;
  let recordConsensusTransaction: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_txlifecycle_e2e_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ eventBus } = await import('../core/EventBus'));
    ({ recordConsensusTransaction } = await import('../core/TransactionRegistry'));

    // Register the real production listener set, in the same relative order SystemBootstrap.ts
    // wires them (EventStore first, then RiskAgent - which pulls in RiskEngine/TradingEngine
    // transitively - then TransactionLifecycleTracker last), so this test would have caught the
    // exact "earlier listener throws, later listener never runs" failure mode this investigation
    // was checking for.
    await import('../core/EventStore');
    await import('./RiskAgent');
    await import('./TransactionLifecycleTracker');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  async function getTxn(id: string) {
    const [row] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, id));
    return row;
  }

  it('a real RiskEngine rejection (invalid price) reaches transactions.status via the full real event chain, not a synthetic emit', async () => {
    const transactionId = await recordConsensusTransaction({
      symbol: 'REGTEST', side: 'BUY', weightedConfidence: 0.8, threshold: 0.75, approved: true, evidence: [],
    });
    expect((await getTxn(transactionId)).status).toBe('OPEN');

    // Real production emission shape (ChiefTraderAgent.evaluateConsensus -> eventBus.emitChiefApproval).
    // No currentPrice - guarantees a real rejection (price_validity, or market_hours if the test
    // happens to run outside real trading hours) - either way, a real gate genuinely fails.
    eventBus.emit('CHIEF_APPROVED_IDEA', {
      transactionId, traceId: 'reg-trace-1', symbol: 'REGTEST', side: 'BUY', confidence: 0.8,
      reasoning: 'test', agentsContext: '', evidence: [],
    });

    // RiskEngine.evaluateRisk is async and RiskAgent fires it without awaiting (matches real
    // production behavior) - poll instead of a fixed sleep since the real gate ladder does real
    // DB/broker calls.
    let txn: any;
    for (let i = 0; i < 50; i++) {
      txn = await getTxn(transactionId);
      if (txn.status !== 'OPEN') break;
      await new Promise(r => setTimeout(r, 50));
    }

    expect(txn.status).toBe('RISK_REJECTED');
    expect(txn.outcome).toBe('N_A');
    expect(txn.closedAt).not.toBeNull();

    // Whichever real gate fires first (market_hours when the test runs outside real trading
    // hours, price_validity otherwise - both are real, not fabricated) is not the point under
    // test here; what matters is that a real rejection reached transactions.status at all.
    const [assessment] = await db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.transactionId, transactionId));
    expect(assessment.approved).toBe(false);
    expect(['price_validity', 'market_hours']).toContain(assessment.rejectionGate);
  });
});
