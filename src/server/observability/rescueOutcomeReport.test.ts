import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('rescueOutcomeReport', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./rescueOutcomeReport');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_rescue_outcome_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./rescueOutcomeReport');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  let idSeq = 0;
  function nextEventId(): string {
    idSeq += 1;
    return `evt-${idSeq}`;
  }

  async function seedRescueGrant(symbol: string, tsMs: number, reasoning: string) {
    await db.insert(schema.observabilityEvents).values({
      id: nextEventId(), ts: tsMs, level: 'info', category: 'DISCOVERY', eventType: 'TEMPORARY_DATA_RESCUE_GRANTED',
      loggerName: 'argus', sessionId: 'test-session',
      symbol, message: 'temporary_data_rescue_granted', payload: JSON.stringify({ reasoning }),
    });
  }

  it('reports zero downstream activity for a rescue that never reached consensus, RiskEngine, or a fill', async () => {
    await seedRescueGrant('LNGX', Date.now(), 'MOMENTUM_BREAKOUT rescue');
    const rows = await mod.buildRescueOutcomeReport(new Date(Date.now() - 60_000).toISOString());
    const row = rows.find((r) => r.symbol === 'LNGX')!;
    expect(row.consensusRoundsObserved).toBe(0);
    expect(row.riskEngineReached).toBe(false);
    expect(row.paperFillProduced).toBe(false);
  });

  it('correctly correlates a rescue that led all the way to a real consensus approval, RiskEngine approval, and a paper fill', async () => {
    const grantedAtMs = Date.now();
    await seedRescueGrant('XOMX', grantedAtMs, 'MOMENTUM_BREAKOUT rescue');

    await db.insert(schema.observabilityEvents).values({
      id: nextEventId(), ts: grantedAtMs + 5000, level: 'info', category: 'CONSENSUS', eventType: 'CONSENSUS_TERMINAL_REASON',
      loggerName: 'argus', sessionId: 'test-session',
      symbol: 'XOMX', message: 'consensus_terminal_reason',
      payload: JSON.stringify({ approved: true, decisionTier: 'STRONG' }),
    });
    await db.insert(schema.riskAssessments).values({
      traceId: 'trace-xomx-1', symbol: 'XOMX', side: 'BUY', approved: true, maxQuantity: 10,
      createdAt: new Date(grantedAtMs + 6000).toISOString(),
    });
    await db.insert(schema.trades).values({
      id: 'trade-xomx-1', symbol: 'XOMX', side: 'BUY', quantity: 10, price: 100, status: 'FILLED',
      timestamp: new Date(grantedAtMs + 7000).toISOString(),
    });

    const rows = await mod.buildRescueOutcomeReport(new Date(grantedAtMs - 60_000).toISOString());
    const row = rows.find((r) => r.symbol === 'XOMX')!;
    expect(row.consensusRoundsObserved).toBe(1);
    expect(row.consensusApproved).toBe(true);
    expect(row.riskEngineReached).toBe(true);
    expect(row.riskApproved).toBe(true);
    expect(row.paperFillProduced).toBe(true);
  });

  it('does not falsely attribute an unrelated HISTORICAL_REPLAY run to a rescue grant just because it touched the same symbol in the follow-up window (real defect found live 2026-09-01)', async () => {
    const grantedAtMs = Date.now();
    await seedRescueGrant('AAPLX', grantedAtMs, 'MOMENTUM_BREAKOUT rescue');

    // No real CONSENSUS_TERMINAL_REASON for this symbol - only a same-symbol replay run's
    // risk_assessments/trades rows land in the follow-up window, exactly like the live case found.
    await db.insert(schema.riskAssessments).values({
      traceId: 'replay-xyz789-1712154600000-AAPLX-BUY-y', symbol: 'AAPLX', side: 'BUY', approved: true, maxQuantity: 10,
      createdAt: new Date(grantedAtMs + 6000).toISOString(),
    });
    await db.insert(schema.trades).values({
      id: 'trade-aaplx-replay-1', symbol: 'AAPLX', side: 'BUY', quantity: 10, price: 100, status: 'FILLED',
      timestamp: new Date(grantedAtMs + 7000).toISOString(),
      executionEnvironment: 'REPLAY', brokerId: 'historical_replay',
    });

    const rows = await mod.buildRescueOutcomeReport(new Date(grantedAtMs - 60_000).toISOString());
    const row = rows.find((r) => r.symbol === 'AAPLX')!;
    expect(row.riskEngineReached).toBe(false);
    expect(row.riskApproved).toBe(false);
    expect(row.paperFillProduced).toBe(false);
  });

  it('REGRESSION 2026-10-14 (engine freeze): query count is constant, not proportional to the number of rescue grants', async () => {
    const base = Date.now();
    for (let i = 0; i < 300; i += 1) await seedRescueGrant(`FRZ${i % 25}`, base + i, 'renewal');
    const spy = vi.spyOn(sqliteDb, 'prepare');
    const rows = await mod.buildRescueOutcomeReport(new Date(base - 60_000).toISOString());
    const prepared = spy.mock.calls.length;
    spy.mockRestore();
    expect(rows.filter((r) => r.symbol.startsWith('FRZ')).length).toBe(300);
    // 1 grant query + 3 batched correlation queries (one chunk of <= 500 symbols); the old N+1 shape issued ~900 queries for 300 grants
    expect(prepared).toBeLessThanOrEqual(8);
  });

  it('formatRescueOutcomeReport never crashes on zero rows', () => {
    expect(mod.formatRescueOutcomeReport([])).toContain('no temporary data rescue grants');
  });
});
