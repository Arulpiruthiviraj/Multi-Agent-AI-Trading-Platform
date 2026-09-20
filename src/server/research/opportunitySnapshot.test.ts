import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('opportunitySnapshot (Institutional Transformation Mandate Part 8/9)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./opportunitySnapshot');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_opp_snapshot_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./opportunitySnapshot');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('returns an empty array when no directional QuantEngine ideas with a real strategy_id exist', async () => {
    const rows = await mod.buildOpportunitySnapshot();
    expect(rows).toEqual([]);
  });

  it('composes a real recent QuantEngine idea with real historical edge, real strategy metadata, and real forward-return data', async () => {
    const ts = new Date().toISOString();
    // Real production reasoning format ("QuantEngine/<STRATEGY>: ...") - agentEdgeAnalytics.ts
    // still derives its strategy grouping from this text (secondaryGroupKey()), not yet from the
    // real strategy_id column added this session (a known, separately-scoped follow-up) - both
    // agree on real production data, so this is the realistic shape to seed, not a workaround.
    await db.insert(schema.agentPredictions).values([
      { id: 'opp-1', agentName: 'QuantEngine', symbol: 'OPPAAPL', prediction: 'BUY', confidence: 0.78, reasoning: 'QuantEngine/MOMENTUM_BREAKOUT: setupScore 0.8, confidence 0.78.', timestamp: ts, traceId: 'trace-opp-1', strategyId: 'MOMENTUM_BREAKOUT' },
      { id: 'opp-2', agentName: 'QuantEngine', symbol: 'OPPAAPL', prediction: 'BUY', confidence: 0.72, reasoning: 'QuantEngine/MOMENTUM_BREAKOUT: setupScore 0.75, confidence 0.72.', timestamp: new Date(Date.now() - 5000).toISOString(), traceId: 'trace-opp-2', strategyId: 'MOMENTUM_BREAKOUT' },
    ]);
    await db.insert(schema.predictionOutcomes).values([
      { predictionId: 'opp-2', sourceTable: 'agent_predictions', symbol: 'OPPAAPL', actualPrice: 101, actualReturn: 0.01, actualDirection: 'UP', outcome: 'WIN', evaluatedAt: ts },
    ]);
    await db.insert(schema.predictionOutcomeHorizons).values([
      { predictionId: 'opp-2', sourceTable: 'agent_predictions', symbol: 'OPPAAPL', horizonLabel: '1_BAR', horizonBars: 1, forwardReturn: 0.005, forwardDirection: 'UP', evaluatedAt: ts },
    ]);

    const rows = await mod.buildOpportunitySnapshot();
    const row = rows.find((r) => r.traceId === 'trace-opp-1')!;
    expect(row).toBeDefined();
    expect(row.symbol).toBe('OPPAAPL');
    expect(row.strategyId).toBe('MOMENTUM_BREAKOUT');
    expect(row.strategyTier).toBe('CORE');
    expect(row.strategyFamily).not.toBeNull();
    expect(row.historicalEdge).not.toBeNull();
    expect(row.historicalEdge!.rawN).toBe(1); // 1 graded WIN
    expect(row.forwardReturnByHorizon.length).toBe(1);
    expect(row.forwardReturnByHorizon[0].horizonLabel).toBe('1_BAR');
    expect(row.alreadyHeld).toBe(false);
  });

  it('falls back to the COLD_START_BOOTSTRAP evidence variant when no EV_BACKED evidence exists - the realistic current-production case (CLAUDE.md: essentially every QuantEngine idea today is still cold-start)', async () => {
    const ts = new Date().toISOString();
    await db.insert(schema.agentPredictions).values([
      {
        id: 'opp-boot-1', agentName: 'QuantEngine', symbol: 'OPPBOOT', prediction: 'SELL', confidence: 0.75,
        reasoning: 'QuantEngine: SIDEWAYS_RANGE regime... Cold-start bootstrap: RANGE_REVERSION is COLD_START (zero real closed trades), so no EV/stop/target backs this idea.',
        timestamp: ts, traceId: 'trace-opp-boot-1', strategyId: 'RANGE_REVERSION',
      },
    ]);
    await db.insert(schema.predictionOutcomes).values([
      { predictionId: 'opp-boot-1', sourceTable: 'agent_predictions', symbol: 'OPPBOOT', actualPrice: 99, actualReturn: -0.01, actualDirection: 'DOWN', outcome: 'WIN', evaluatedAt: ts },
    ]);

    const rows = await mod.buildOpportunitySnapshot();
    const row = rows.find((r) => r.traceId === 'trace-opp-boot-1')!;
    expect(row).toBeDefined();
    expect(row.historicalEdge).not.toBeNull();
    expect(row.historicalEdge!.variant).toBe('COLD_START_BOOTSTRAP');
    expect(row.historicalEdge!.rawN).toBe(1);
  });

  it('marks alreadyHeld=true when the symbol is a real current open position', async () => {
    await db.insert(schema.portfolio).values({
      symbol: 'OPPAAPL', quantity: 10, averagePrice: 100, currentPrice: 101, lastUpdated: new Date().toISOString(),
    });
    const rows = await mod.buildOpportunitySnapshot();
    const row = rows.find((r) => r.symbol === 'OPPAAPL')!;
    expect(row.alreadyHeld).toBe(true);
  });

  it('modelForecast is null by default (no forecast has been built for this key) - never fabricated', async () => {
    const rows = await mod.buildOpportunitySnapshot();
    const row = rows.find((r) => r.symbol === 'OPPAAPL')!;
    expect(row.modelForecast).toBeNull();
  });

  it('modelForecast populates from a real, already-persisted forecast (Part 7/24 integration) without a live Java call', async () => {
    const { quantForecasts } = schema;
    await db.insert(quantForecasts).values({
      forecastId: 'opp-forecast-1', symbol: 'OPPAAPL', createdAt: new Date().toISOString(),
      direction: 'BUY', horizonLabel: 'PRIMARY_EVAL_HORIZON', agentName: 'QuantEngine', strategyId: 'MOMENTUM_BREAKOUT',
      forecastStatus: 'VALID', sampleSize: 25, expectedReturn: 0.008, probabilityOfProfit: 0.62,
      estimatedTransactionCostBps: 5, netExpectedReturn: 0.0075, modelVersion: 'test-v1',
      strategyCount: 7, familyCount: 3, effectiveIndependentCount: 2.6,
      provenanceJson: JSON.stringify({ sourceTable: 'prediction_outcomes', groupingKey: 'QuantEngine/MOMENTUM_BREAKOUT', sourceRowCount: 25, transactionCostSource: 'NONE_ASSUMED_ZERO' }),
    });

    const rows = await mod.buildOpportunitySnapshot();
    const row = rows.find((r) => r.symbol === 'OPPAAPL')!;
    expect(row.modelForecast).not.toBeNull();
    expect(row.modelForecast!.status).toBe('VALID');
    expect(row.modelForecast!.expectedReturn).toBeCloseTo(0.008, 5);
    expect(row.modelForecast!.probabilityOfProfit).toBeNull();
    expect(row.modelForecast!.netExpectedReturn).toBeNull();
    // Real strategy-diversity evidence (Part 7/9 integration) - never inflated, never fabricated.
    expect(row.modelForecast!.strategyCount).toBe(7);
    expect(row.modelForecast!.familyCount).toBe(3);
    expect(row.modelForecast!.effectiveIndependentCount).toBe(2.6);

    const text = mod.formatOpportunitySnapshot(rows);
    expect(text).toContain('0.80%/UNKNOWN');
    expect(text).toContain('2.6(3)'); // effectiveIndependentCount(familyCount) rendered in the text table
  });

  it('modelForecast diversity fields stay null (UNKNOWN, never fabricated) when a persisted forecast carries no real ensemble evidence', async () => {
    const { quantForecasts } = schema;
    await db.insert(quantForecasts).values({
      forecastId: 'opp-forecast-noev', symbol: 'OPPNOEV', createdAt: new Date().toISOString(),
      direction: 'BUY', horizonLabel: 'PRIMARY_EVAL_HORIZON', agentName: 'QuantEngine', strategyId: 'RANGE_REVERSION',
      forecastStatus: 'VALID', sampleSize: 25, expectedReturn: 0.003, probabilityOfProfit: 0.51,
      estimatedTransactionCostBps: 0, netExpectedReturn: 0.003, modelVersion: 'test-v1',
      provenanceJson: JSON.stringify({ sourceTable: 'prediction_outcomes', groupingKey: 'QuantEngine/RANGE_REVERSION', sourceRowCount: 25, transactionCostSource: 'NONE_ASSUMED_ZERO' }),
    });
    await db.insert(schema.agentPredictions).values({
      id: 'opp-noev-1', agentName: 'QuantEngine', symbol: 'OPPNOEV', prediction: 'BUY', confidence: 0.7,
      reasoning: 'QuantEngine/RANGE_REVERSION: setupScore 0.7.', timestamp: new Date().toISOString(), strategyId: 'RANGE_REVERSION',
    });

    const rows = await mod.buildOpportunitySnapshot();
    const row = rows.find((r) => r.symbol === 'OPPNOEV')!;
    expect(row.modelForecast).not.toBeNull();
    expect(row.modelForecast!.strategyCount).toBeNull();
    expect(row.modelForecast!.familyCount).toBeNull();
    expect(row.modelForecast!.effectiveIndependentCount).toBeNull();

    const text = mod.formatOpportunitySnapshot(rows);
    expect(text).toContain('UNKNOWN');
  });

  it('only includes directional (BUY/SELL) ideas, never HOLD', async () => {
    await db.insert(schema.agentPredictions).values({
      id: 'opp-hold', agentName: 'QuantEngine', symbol: 'OPPHOLD', prediction: 'HOLD', confidence: 0.5, reasoning: 'test', timestamp: new Date().toISOString(), strategyId: 'MEAN_REVERSION',
    });
    const rows = await mod.buildOpportunitySnapshot();
    expect(rows.some((r) => r.symbol === 'OPPHOLD')).toBe(false);
  });

  it('formatOpportunitySnapshot renders a readable text table', async () => {
    const rows = await mod.buildOpportunitySnapshot();
    const text = mod.formatOpportunitySnapshot(rows);
    expect(text).toContain('REAL OPPORTUNITY SNAPSHOT');
    expect(text).toContain('OPPAAPL');
  });
});
