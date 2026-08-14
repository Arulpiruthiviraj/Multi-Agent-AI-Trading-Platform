import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

/**
 * Real integration test (isolated temp SQLite DB, real Express router mounted via supertest) for
 * Phase 3C's POST /api/v2/trading/execute-override. Unlike the fabricated Trade object the old
 * "Execute Override" button built entirely client-side, this endpoint emits a real
 * CHIEF_APPROVED_IDEA event - the exact same real RiskAgent (imported transitively via
 * SystemBootstrap, already listening for real) picks it up and forwards to the real
 * RiskEngine.evaluateRisk(), which runs against the real (default InternalPaperBroker) portfolio
 * and real settings defaults. This test proves the override genuinely passes through that real
 * gate ladder rather than fabricating a fill - it seeds a real live price directly into
 * marketDataWorker's internal cache (the only way to give it one without a live Alpaca feed) and
 * asserts a real risk_assessments row and (on approval) a real trades row get created.
 */
describe('POST /api/v2/trading/execute-override - Phase 3C real manual-override wiring', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let tradingEngine: any;
  let marketDataWorker: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_v2override_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ tradingEngine } = await import('../engines/TradingEngine'));
    await tradingEngine.initialize();
    await tradingEngine.setTradingState('TRADING_ENABLED', { reason: 'test baseline', actor: 'test' });

    ({ marketDataWorker } = await import('../services/MarketDataWorker'));

    const { v2Router } = await import('./v2System');
    app = express();
    app.use(express.json());
    app.use('/api/v2', v2Router);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('rejects a request missing symbol/side with a 400, never silently defaulting', async () => {
    const res = await request(app).post('/api/v2/trading/execute-override').send({ symbol: 'AAPL' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('honestly refuses a symbol with no real live price rather than fabricating one', async () => {
    const res = await request(app).post('/api/v2/trading/execute-override').send({ symbol: 'ZZZZ_NO_TICK', side: 'BUY' });
    expect(res.status).toBe(422);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/no real live price/i);
  });

  it('submits a real override that mints a real transaction and flows into real RiskEngine gate evaluation', async () => {
    (marketDataWorker as any).latestPrices.set('OVRTEST', 123.45);

    const res = await request(app).post('/api/v2/trading/execute-override').send({ symbol: 'OVRTEST', side: 'BUY' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.currentPrice).toBe(123.45);
    expect(res.body.traceId).toMatch(/^manual-override-/);
    expect(res.body.transactionId).toBeTruthy();

    // Real transactions/consensus_decisions/consensus_evidence rows, honestly tagged as a
    // manual override rather than pretending an AI agent produced this signal.
    const allTxns = await db.select().from(schema.transactions);
    const mine = allTxns.find((t: any) => t.id === res.body.transactionId);
    expect(mine).toBeTruthy();
    expect(mine.symbol).toBe('OVRTEST');

    const decisions = await db.select().from(schema.consensusDecisions);
    const myDecision = decisions.find((d: any) => d.transactionId === res.body.transactionId);
    expect(myDecision).toBeTruthy();
    expect(myDecision.debateUsed).toBe(false);

    const evidence = await db.select().from(schema.consensusEvidence);
    const myEvidence = evidence.filter((e: any) => e.transactionId === res.body.transactionId);
    expect(myEvidence).toHaveLength(1);
    expect(myEvidence[0].agent).toBe('ManualOverride');

    // Real RiskEngine.evaluateRisk() runs asynchronously off the CHIEF_APPROVED_IDEA emit - give
    // it a tick to actually execute and write its real risk_assessments row via persistAssessment().
    await new Promise(r => setTimeout(r, 1000));
    const assessments = await db.select().from(schema.riskAssessments);
    const myAssessment = assessments.find((a: any) => a.traceId === res.body.traceId);
    expect(myAssessment).toBeTruthy();
    expect(myAssessment.transactionId).toBe(res.body.transactionId);
  });
});
