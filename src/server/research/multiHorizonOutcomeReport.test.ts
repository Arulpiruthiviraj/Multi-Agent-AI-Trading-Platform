import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('multiHorizonOutcomeReport (Research Memory Platform Phase 2)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./multiHorizonOutcomeReport');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_multihorizon_report_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./multiHorizonOutcomeReport');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('returns an empty array when no horizon rows exist yet', async () => {
    const rows = await mod.buildMultiHorizonSummaryReport();
    expect(rows).toEqual([]);
  });

  it('groups real horizon rows by (agentName, strategyId, horizonLabel), joining back to agent_predictions for real strategy attribution', async () => {
    const ts = new Date().toISOString();
    await db.insert(schema.agentPredictions).values([
      { id: 'mhr-1', agentName: 'QuantEngine', symbol: 'MHR', prediction: 'BUY', confidence: 0.8, reasoning: 'test', timestamp: ts, strategyId: 'MOMENTUM_BREAKOUT' },
      { id: 'mhr-2', agentName: 'QuantEngine', symbol: 'MHR', prediction: 'BUY', confidence: 0.75, reasoning: 'test', timestamp: ts, strategyId: 'MOMENTUM_BREAKOUT' },
      { id: 'mhr-3', agentName: 'TechnicalAgent', symbol: 'MHR', prediction: 'BUY', confidence: 0.7, reasoning: 'test', timestamp: ts },
    ]);
    await db.insert(schema.predictionOutcomeHorizons).values([
      { predictionId: 'mhr-1', sourceTable: 'agent_predictions', symbol: 'MHR', horizonLabel: '1_BAR', horizonBars: 1, forwardReturn: 0.01, forwardDirection: 'UP', evaluatedAt: ts },
      { predictionId: 'mhr-2', sourceTable: 'agent_predictions', symbol: 'MHR', horizonLabel: '1_BAR', horizonBars: 1, forwardReturn: -0.02, forwardDirection: 'DOWN', evaluatedAt: ts },
      { predictionId: 'mhr-3', sourceTable: 'agent_predictions', symbol: 'MHR', horizonLabel: '1_BAR', horizonBars: 1, forwardReturn: 0.03, forwardDirection: 'UP', evaluatedAt: ts },
    ]);

    const rows = await mod.buildMultiHorizonSummaryReport();
    const momentum = rows.find((r) => r.strategyId === 'MOMENTUM_BREAKOUT' && r.horizonLabel === '1_BAR')!;
    expect(momentum).toBeDefined();
    expect(momentum.n).toBe(2);
    expect(momentum.meanForwardReturn).toBeCloseTo((0.01 + -0.02) / 2, 5);
    expect(momentum.positiveReturnRate).toBeCloseTo(0.5, 5);

    const technical = rows.find((r) => r.agentName === 'TechnicalAgent' && r.horizonLabel === '1_BAR')!;
    expect(technical).toBeDefined();
    expect(technical.strategyId).toBeNull();
    expect(technical.n).toBe(1);
  });

  it('agentName filter narrows the report to only that agent\'s rows', async () => {
    const rows = await mod.buildMultiHorizonSummaryReport('TechnicalAgent');
    expect(rows.every((r) => r.agentName === 'TechnicalAgent')).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('formatMultiHorizonSummaryReport renders a readable text table', async () => {
    const rows = await mod.buildMultiHorizonSummaryReport();
    const text = mod.formatMultiHorizonSummaryReport(rows);
    expect(text).toContain('MULTI-HORIZON FORWARD OUTCOME SUMMARY');
    expect(text).toContain('MOMENTUM_BREAKOUT');
  });
});
