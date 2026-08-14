import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

/**
 * Phase 8 (ARGUS_PRE_IMPLEMENTATION_BASELINE.md) - real coverage proving `GET /api/v2/transactions/:id`
 * now actually joins the real AI call ledger (`ai_calls`) and the real quant feature snapshot
 * (`quant_assessments`) into the single "assemble everything about this decision" response -
 * previously both tables existed and were written to, but neither was ever linked into this
 * endpoint. Real isolated temp SQLite DB, real Express router mounted via supertest, matching the
 * established pattern in v2System.quantObservability.test.ts.
 */
describe('GET /api/v2/transactions/:id - AI call ledger + quant snapshot join (Phase 8)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_txnassembly_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');

    const openedAt = '2026-01-01T12:00:00.000Z';

    await db.insert(schema.transactions).values({
      id: 'txn-phase8-1', symbol: 'AAPL', openedAt, status: 'EXECUTED', finalDecision: 'BUY',
    });
    await db.insert(schema.consensusEvidence).values({
      transactionId: 'txn-phase8-1', sourceTraceId: 'trace-phase8-1', agent: 'FundamentalAgent',
      side: 'BUY', confidence: 0.8, weight: 0.2, reasoning: 'test', agreed: true, currentPrice: 150,
    });

    // Real AI call, linked by BOTH transactionId (a call made after the transaction existed)
    // and by traceId (a call made before ChiefTraderAgent minted the transaction id - the exact
    // real-world case aiCalls.transactionId being nullable exists for).
    await db.insert(schema.aiCalls).values({
      id: 'ai-call-1', traceId: 'trace-phase8-1', transactionId: null, agent: 'FundamentalAgent',
      provider: 'gemini', model: 'gemini-2.5-flash', prompt: 'real prompt text',
      rawResponse: '{"recommendation":"BUY"}', status: 'success', createdAt: '2026-01-01T11:59:00.000Z',
    });
    await db.insert(schema.aiCalls).values({
      id: 'ai-call-2', traceId: null, transactionId: 'txn-phase8-1', agent: 'ChiefTraderAgent',
      provider: 'openai', model: 'gpt-4o', prompt: 'debate prompt', rawResponse: '{}',
      status: 'success', createdAt: '2026-01-01T12:00:30.000Z',
    });

    // Real quant feature snapshot, before the transaction's openedAt (a real, honest
    // "closest prior cycle" match).
    await db.insert(schema.quantAssessments).values({
      id: 'qa-1', symbol: 'AAPL', timeframe: '1Day',
      regime: JSON.stringify({ regime: 'BULLISH_TREND' }),
      marketContext: JSON.stringify({ spy: { trend: 'up' } }),
      createdAt: '2026-01-01T11:55:00.000Z',
    });
    // A later snapshot, AFTER openedAt - must NOT be picked (never uses future information).
    await db.insert(schema.quantAssessments).values({
      id: 'qa-2', symbol: 'AAPL', timeframe: '1Day',
      regime: JSON.stringify({ regime: 'BEARISH_TREND' }),
      marketContext: JSON.stringify({ spy: { trend: 'down' } }),
      createdAt: '2026-01-01T12:05:00.000Z',
    });

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

  it('joins real AI calls linked by both transactionId and traceId', async () => {
    const res = await request(app).get('/api/v2/transactions/txn-phase8-1');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const ids = res.body.aiCalls.map((c: any) => c.id).sort();
    expect(ids).toEqual(['ai-call-1', 'ai-call-2']);
  });

  it('joins the real quant feature snapshot closest in time BEFORE the transaction opened - never a future one', async () => {
    const res = await request(app).get('/api/v2/transactions/txn-phase8-1');
    expect(res.status).toBe(200);
    expect(res.body.quantAssessment.id).toBe('qa-1');
    expect(res.body.quantAssessment.regime.regime).toBe('BULLISH_TREND'); // real parsed JSON, not a string
  });

  it('the markdown report includes both new sections', async () => {
    const res = await request(app).get('/api/v2/transactions/txn-phase8-1/report.md');
    expect(res.status).toBe(200);
    expect(res.text).toContain('## AI Calls');
    expect(res.text).toContain('FundamentalAgent');
    expect(res.text).toContain('## Quant Feature Snapshot');
  });
});
