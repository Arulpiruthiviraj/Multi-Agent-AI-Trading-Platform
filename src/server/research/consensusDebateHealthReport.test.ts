import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('consensusDebateHealthReport (P0.5 forensic measurement)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./consensusDebateHealthReport');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_debate_report_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./consensusDebateHealthReport');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  function pred(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id, traceId: `t-${id}`, symbol: 'RPT', createdAt: new Date().toISOString(),
      debateStatus: 'VALID_PREDICTION', debateDirection: 'HOLD', debateConfidence: 0.8,
      providersAttempted: 1, providersSucceeded: 1, providersFailed: 0,
      underlyingAgentCount: 2, underlyingEvidenceJson: '[]',
      baseConsensusSide: 'BUY', baseConsensusConfidence: 0.83,
      baseClearsThreshold: true, baseClearsIndependence: true,
      withDebateConsensusSide: 'BUY', withDebateConsensusConfidence: 0.1,
      withDebateApproved: false, vetoFired: true, marketRegime: 'BULLISH_TREND',
      ...overrides,
    };
  }

  function outcome(predictionId: string, actualReturn: number) {
    return {
      predictionId, sourceTable: 'consensus_debate_predictions', symbol: 'RPT',
      actualPrice: 100, actualReturn, actualDirection: actualReturn >= 0 ? 'UP' : 'DOWN',
      mfe: null, mae: null, outcome: actualReturn >= 0 ? 'WIN' : 'LOSS',
      evaluatedAt: new Date().toISOString(),
    };
  }

  it('reports INSUFFICIENT_DATA with zero rows, never fabricating a verdict', async () => {
    const report = await mod.buildConsensusDebateHealthReport();
    expect(report.recommendation).toBe('INSUFFICIENT_DATA');
    expect(report.vetoStats.netEconomicValueOfVetoes).toBeNull();
    expect(report.sampleSize).toBe(0);
  });

  it('classifies GOOD_VETO (negative forward return) and BAD_VETO (positive forward return) correctly, and computes real net economic value', async () => {
    await db.insert(schema.consensusDebatePredictions).values([
      pred('rpt-1'), pred('rpt-2'), pred('rpt-3'),
    ]);
    await db.insert(schema.predictionOutcomes).values([
      outcome('rpt-1', -0.02), // good veto: avoided a -2% loser
      outcome('rpt-2', -0.01), // good veto
      outcome('rpt-3', 0.015), // bad veto: blocked a +1.5% winner
    ]);

    const report = await mod.buildConsensusDebateHealthReport();
    expect(report.vetoStats.vetoFiredCount).toBe(3);
    expect(report.vetoStats.gradedCount).toBe(3);
    expect(report.vetoStats.goodVetoCount).toBe(2);
    expect(report.vetoStats.badVetoCount).toBe(1);
    expect(report.vetoStats.vetoPrecision).toBeCloseTo(2 / 3, 5);
    expect(report.vetoStats.avgReturnAvoided).toBeCloseTo(-0.015, 5);
    expect(report.vetoStats.avgReturnDestroyed).toBeCloseTo(0.015, 5);
    // net = -0.02 + -0.01 + 0.015 = -0.015 (net destructive in this small sample)
    expect(report.vetoStats.netEconomicValueOfVetoes).toBeCloseTo(-0.015, 5);
  });

  it('excludes non-vetoFired and fail-closed rows from veto stats', async () => {
    await db.insert(schema.consensusDebatePredictions).values([
      pred('rpt-novo', { vetoFired: false }),
      pred('rpt-fc', { debateStatus: 'FAIL_CLOSED_ERROR', debateDirection: null, debateConfidence: null, vetoFired: false }),
    ]);
    await db.insert(schema.predictionOutcomes).values([outcome('rpt-novo', 0.05)]);

    const report = await mod.buildConsensusDebateHealthReport();
    // Still only the 3 vetoFired rows from the previous test count toward veto stats.
    expect(report.vetoStats.vetoFiredCount).toBe(3);
    expect(report.usage.failClosedError).toBe(1);
  });

  it('groups regime breakdown by real marketRegime, using (unknown) for null', async () => {
    await db.insert(schema.consensusDebatePredictions).values([
      pred('rpt-regime-1', { marketRegime: 'SIDEWAYS_RANGE' }),
    ]);
    await db.insert(schema.predictionOutcomes).values([outcome('rpt-regime-1', -0.005)]);

    const report = await mod.buildConsensusDebateHealthReport();
    const sideways = report.regimeBreakdown.find((r) => r.regime === 'SIDEWAYS_RANGE');
    expect(sideways).toBeDefined();
    expect(sideways!.n).toBe(1);
    const bullish = report.regimeBreakdown.find((r) => r.regime === 'BULLISH_TREND');
    expect(bullish!.n).toBe(3);
  });

  it('formatConsensusDebateHealthReport renders a readable text report', async () => {
    const report = await mod.buildConsensusDebateHealthReport();
    const text = mod.formatConsensusDebateHealthReport(report);
    expect(text).toContain('CONSENSUS DEBATE HEALTH REPORT');
    expect(text).toContain('NET ECONOMIC VALUE OF VETOES');
    expect(text).toContain('RECOMMENDATION:');
  });
});
