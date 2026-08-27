import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('LearningObservationRecorder', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let mod: typeof import('./LearningObservationRecorder');
  let schema: typeof import('../db/schema');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_learningobs_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./LearningObservationRecorder');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('records a FILLED trade as EXECUTED trust, CLOSED_TRADE type', async () => {
    const trade: any = {
      id: 't1', symbol: 'AAPL', side: 'BUY', quantity: 10, price: 150, status: 'FILLED',
      timestamp: new Date().toISOString(), reasoning: 'test', traceId: 'trace-1', profitLoss: 42.5,
    };
    await mod.recordExecutedTradeObservation(trade);
    const rows = await mod.getLearningObservations({ observationType: 'CLOSED_TRADE' });
    expect(rows.length).toBe(1);
    expect(rows[0].trustLevel).toBe('EXECUTED');
    expect(JSON.parse(rows[0].outcomeJson!).profitLoss).toBe(42.5);
  });

  it('does not record a non-FILLED trade', async () => {
    const trade: any = {
      id: 't2', symbol: 'TSLA', side: 'BUY', quantity: 5, price: 200, status: 'PENDING',
      timestamp: new Date().toISOString(), reasoning: null, traceId: null, profitLoss: null,
    };
    const before = (await mod.getLearningObservations({})).length;
    await mod.recordExecutedTradeObservation(trade);
    const after = (await mod.getLearningObservations({})).length;
    expect(after).toBe(before);
  });

  it('records a rejected candidate as OBSERVATIONAL trust', async () => {
    await mod.recordRejectedCandidateObservation({
      symbol: 'MSFT', rejectionGate: 'symbol_concentration', rejectionReason: 'over concentration cap',
      finalScore: 0.6, traceId: 'trace-2',
    });
    const rows = await mod.getLearningObservations({ observationType: 'REJECTED_CANDIDATE' });
    expect(rows.length).toBe(1);
    expect(rows[0].trustLevel).toBe('OBSERVATIONAL');
    expect(rows[0].outcomeJson).toBeNull();
  });

  it('records an EVALUATED missed opportunity as OBSERVATIONAL trust, but skips PENDING ones', async () => {
    const pendingMiss: any = {
      id: 'm1', symbol: 'NVDA', detectedAt: new Date().toISOString(), classification: 'AGENT_MISS',
      classificationReason: 'test', priceAtDetection: 100, evaluationStatus: 'PENDING',
      maxFavorableExcursionPct: null, maxAdverseExcursionPct: null,
    };
    const before = (await mod.getLearningObservations({})).length;
    await mod.recordMissedOpportunityObservation(pendingMiss);
    expect((await mod.getLearningObservations({})).length).toBe(before);

    const evaluatedMiss: any = {
      id: 'm2', symbol: 'NVDA', detectedAt: new Date().toISOString(), classification: 'AGENT_MISS',
      classificationReason: 'test', priceAtDetection: 100, evaluationStatus: 'EVALUATED',
      maxFavorableExcursionPct: 4.2, maxAdverseExcursionPct: -1.1,
    };
    await mod.recordMissedOpportunityObservation(evaluatedMiss);
    const rows = await mod.getLearningObservations({ observationType: 'MISSED_OPPORTUNITY' });
    expect(rows.length).toBe(1);
    expect(rows[0].trustLevel).toBe('OBSERVATIONAL');
    expect(JSON.parse(rows[0].outcomeJson!).maxFavorableExcursionPct).toBe(4.2);
  });

  it('computes a trust-level breakdown across all recorded observation types', async () => {
    const breakdown = await mod.getTrustLevelBreakdown(new Date(Date.now() - 3600000).toISOString());
    expect(breakdown.executed).toBe(1);
    expect(breakdown.observational).toBe(2);
    expect(breakdown.byType.CLOSED_TRADE).toBe(1);
    expect(breakdown.byType.REJECTED_CANDIDATE).toBe(1);
    expect(breakdown.byType.MISSED_OPPORTUNITY).toBe(1);
  });
});
