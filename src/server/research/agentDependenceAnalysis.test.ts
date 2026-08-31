import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('agentDependenceAnalysis', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./agentDependenceAnalysis');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_agent_dependence_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./agentDependenceAnalysis');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  function seed(agent: string, symbol: string, side: string, ts: number, outcome: 'WIN' | 'LOSS' | 'N_A', idSuffix: string) {
    const id = `pred-${agent}-${idSuffix}`;
    return Promise.all([
      db.insert(schema.agentPredictions).values({
        id, agentName: agent, symbol, prediction: side, confidence: 0.7,
        reasoning: 'test', timestamp: new Date(ts).toISOString(),
      }),
      db.insert(schema.predictionOutcomes).values({
        predictionId: id, sourceTable: 'agent_predictions', symbol,
        actualPrice: 101, actualReturn: 0.01, actualDirection: side === 'BUY' ? 'UP' : 'DOWN',
        mfe: 0.01, mae: 0, outcome, evaluatedAt: new Date(ts).toISOString(),
      }),
    ]);
  }

  it('DEPENDENCE_PAIRS covers exactly the 6 pairs the mission specifies', () => {
    const set = new Set(mod.DEPENDENCE_PAIRS.map(([a, b]) => `${a}|${b}`));
    expect(set.has('TechnicalAgent|QuantEngine')).toBe(true);
    expect(set.has('TechnicalAgent|FundamentalAgent')).toBe(true);
    expect(set.has('TechnicalAgent|MacroAgent')).toBe(true);
    expect(set.has('QuantEngine|FundamentalAgent')).toBe(true);
    expect(set.has('QuantEngine|MacroAgent')).toBe(true);
    expect(set.has('FundamentalAgent|MacroAgent')).toBe(true);
    expect(mod.DEPENDENCE_PAIRS.length).toBe(6);
  });

  it('analyzePair finds INSUFFICIENT_DATA when the two agents never co-occur', () => {
    const rows = [
      { agentName: 'A1', symbol: 'AAA', side: 'BUY', timestampMs: 1000, outcome: 'WIN' as const },
      { agentName: 'B1', symbol: 'BBB', side: 'BUY', timestampMs: 2000, outcome: 'WIN' as const },
    ];
    const result = mod.analyzePair(rows, 'A1', 'B1', 60000);
    expect(result.coOccurrenceN).toBe(0);
    expect(result.status).toBe('INSUFFICIENT_DATA');
  });

  it('detects genuine INCREMENTAL_VALUE when agreement between two agents wins more often than either alone (independent agreement)', async () => {
    const base = new Date('2026-08-05T09:00:00.000Z').getTime();
    // A always says BUY (50% overall win rate - right on even i, wrong on odd i).
    // B agrees (BUY) on even i, disagrees (SELL) on odd i - also 50% overall win rate alone.
    // When they AGREE (even i only), the outcome is ALWAYS a win for both - a genuine incremental
    // signal only visible in the agreement subset, not in either agent's own unconditional rate.
    for (let i = 0; i < 50; i++) {
      const outcome = i % 2 === 0 ? 'WIN' : 'LOSS';
      const ts = base + i * 3 * 60 * 60000;
      await seed('IndepA', `SYM${i}`, 'BUY', ts, outcome, `a${i}`);
      await seed('IndepB', `SYM${i}`, i % 2 === 0 ? 'BUY' : 'SELL', ts + 1000, outcome, `b${i}`);
    }
    const { db: rawDb } = await import('../db');
    const rowsRaw = await rawDb.select().from(schema.agentPredictions);
    const outcomesRaw = await rawDb.select().from(schema.predictionOutcomes);
    const outcomeByPredId = new Map(outcomesRaw.map((o: any) => [o.predictionId, o]));
    const rows = rowsRaw
      .filter((p: any) => p.agentName === 'IndepA' || p.agentName === 'IndepB')
      .map((p: any) => ({
        agentName: p.agentName, symbol: p.symbol, side: p.prediction,
        timestampMs: new Date(p.timestamp).getTime(),
        outcome: outcomeByPredId.get(p.id)?.outcome ?? null,
      }));

    const result = mod.analyzePair(rows, 'IndepA', 'IndepB', 5 * 60000);
    expect(result.coOccurrenceN).toBe(50);
    expect(result.directionalAgreementN).toBe(25); // only the even i's agree (both BUY)
    expect(result.agreementWinRate).toBe(1);
    expect(result.baselineWinRateA).toBeCloseTo(0.5);
    expect(result.status).toBe('INCREMENTAL_VALUE');
    expect(result.lift).not.toBeNull();
    expect(result.lift!).toBeGreaterThan(0);
  });

  it('reports NO_INCREMENTAL_VALUE when agreement win rate is no better than either agent alone (dependent/redundant agreement)', () => {
    const base = 1000;
    const rows: Array<{ agentName: string; symbol: string; side: string; timestampMs: number; outcome: 'WIN' | 'LOSS' | 'N_A' | null }> = [];
    // Both agents share the exact same real accuracy (60%) whether they agree or not - agreeing
    // adds no incremental information, it is just two views of the same underlying signal.
    for (let i = 0; i < 30; i++) {
      const outcome = i < 18 ? 'WIN' : 'LOSS';
      rows.push({ agentName: 'DepA', symbol: `S${i}`, side: 'BUY', timestampMs: base + i * 3 * 60 * 60000, outcome });
      rows.push({ agentName: 'DepB', symbol: `S${i}`, side: 'BUY', timestampMs: base + i * 3 * 60 * 60000 + 500, outcome });
    }
    const result = mod.analyzePair(rows, 'DepA', 'DepB', 5 * 60000);
    expect(result.coOccurrenceN).toBe(30);
    expect(result.directionalAgreementN).toBe(30);
    expect(result.agreementWinRate).toBeCloseTo(0.6);
    expect(result.baselineWinRateA).toBeCloseTo(0.6);
    expect(result.status).toBe('NO_INCREMENTAL_VALUE');
  });

  it('formatAgentDependenceReport renders a readable text table', async () => {
    const rows = await mod.buildAgentDependenceReport();
    const text = mod.formatAgentDependenceReport(rows);
    expect(text).toContain('AGENT COMBINATION EDGE');
    expect(text).toContain('TechnicalAgent<->QuantEngine');
  });
});
