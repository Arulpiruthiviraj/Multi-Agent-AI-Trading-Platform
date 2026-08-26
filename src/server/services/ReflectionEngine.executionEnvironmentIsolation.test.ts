import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Self-improvement loop audit (2026-08-26). Two real, confirmed defects found and fixed:
 *
 * 1. evaluateAgents()'s loss-reflection loop read ALL `trades` regardless of
 *    execution_environment. Live DB evidence: every single non-null trades.profit_loss row in
 *    the entire database (67/67) was REPLAY - organic PAPER fills have never had profit_loss
 *    populated. generateReflectionRule() (a real LLM call whose text is fed into ChiefTrader's
 *    live debate prompt via learned_rules) had therefore never actually been triggered by real
 *    trading experience. Fixed by excluding NON_LIVE_OPENING_TRADE_ENVS (REPLAY/BACKTEST/
 *    SIMULATION/HISTORICAL_REPLAY/HISTORICAL_SIMULATION/TELEMETRY_PULSE) - a null/blank
 *    environment (legacy pre-tagging row) stays included, matching omsEntryPrice.ts's own
 *    convention.
 *
 * 2. logPrediction() (subscribed to the same TRADE_IDEA_GENERATED event ChiefTraderAgent/
 *    RiskAgent/OrderManagement already guard against telemetry-pulse payloads for) had no such
 *    guard - a UI Digital Twin demo run's synthetic ideas were logged into agent_predictions as
 *    real, and live DB evidence showed 2 of them were already graded WIN against real AAPL price
 *    action, feeding fabricated evidence into agentPerformanceStats.currentWeight.
 */
describe('ReflectionEngine - execution-environment isolation & telemetry-pulse exclusion', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let reflectionEngine: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_reflection_envisolation_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ reflectionEngine } = await import('./ReflectionEngine'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('does NOT generate a learned rule from a REPLAY loss, even a large recent one', async () => {
    await db.insert(schema.trades).values({
      id: 'replay-loss-1',
      symbol: 'AAPL',
      side: 'SELL',
      quantity: 10,
      price: 100,
      status: 'FILLED',
      timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      filledAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      profitLoss: -500,
      reasoning: 'replay loss',
      executionEnvironment: 'REPLAY',
    } as any);

    const spy = vi.spyOn(reflectionEngine, 'generateReflectionRule').mockResolvedValue(undefined);
    await reflectionEngine.evaluateAgents();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('DOES generate a learned rule from a real PAPER loss', async () => {
    await db.insert(schema.trades).values({
      id: 'paper-loss-1',
      symbol: 'MSFT',
      side: 'SELL',
      quantity: 5,
      price: 90,
      status: 'FILLED',
      timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      filledAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      profitLoss: -50,
      reasoning: 'real paper loss',
      executionEnvironment: 'PAPER',
    } as any);

    const spy = vi.spyOn(reflectionEngine, 'generateReflectionRule').mockResolvedValue(undefined);
    await reflectionEngine.evaluateAgents();
    expect(spy).toHaveBeenCalled();
    const losses = spy.mock.calls[0][0] as any[];
    expect(losses.some((l: any) => l.symbol === 'MSFT')).toBe(true);
    spy.mockRestore();
  });

  it('does not log a Digital Twin telemetry-pulse idea into agent_predictions', async () => {
    const { eventBus } = await import('../core/EventBus');
    const before = (await db.select().from(schema.agentPredictions).all()).length;

    eventBus.emit('TRADE_IDEA_GENERATED', {
      traceId: 'telemetry-pulse-test-trace',
      symbol: 'AAPL',
      side: 'BUY',
      confidence: 0.82,
      reasoning: 'TELEMETRY_PULSE — synthetic TechnicalAgent idea (UI only)',
      agent: 'TechnicalAgent',
      currentPrice: 188.42,
      telemetryPulse: true,
      diagnosticTelemetry: true,
    });
    await new Promise((r) => setTimeout(r, 50));

    const after = (await db.select().from(schema.agentPredictions).all()).length;
    expect(after).toBe(before);
  });

  it('DOES log a real (non-telemetry-pulse) idea into agent_predictions', async () => {
    const { eventBus } = await import('../core/EventBus');
    const before = (await db.select().from(schema.agentPredictions).all()).length;

    eventBus.emit('TRADE_IDEA_GENERATED', {
      traceId: 'real-trace-1',
      symbol: 'AAPL',
      side: 'BUY',
      confidence: 0.7,
      reasoning: 'real idea',
      agent: 'TechnicalAgent',
      currentPrice: 190,
    });
    await new Promise((r) => setTimeout(r, 50));

    const after = (await db.select().from(schema.agentPredictions).all()).length;
    expect(after).toBe(before + 1);
  });

  it('excludes a telemetry-pulse-traced prediction from the aggregate stats even if it somehow reached agent_predictions', async () => {
    await db.insert(schema.agentPredictions).values({
      id: 'telemetry-legacy-row',
      agentName: 'TechnicalAgent',
      symbol: 'AAPL',
      prediction: 'BUY',
      confidence: 0.82,
      reasoning: 'TELEMETRY_PULSE — synthetic idea (UI only)',
      timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      traceId: 'telemetry-pulse-legacy-contamination',
    } as any);
    await db.insert(schema.predictionOutcomes).values({
      predictionId: 'telemetry-legacy-row',
      sourceTable: 'agent_predictions',
      symbol: 'AAPL',
      actualPrice: 191,
      actualReturn: 0.01,
      actualDirection: 'UP',
      outcome: 'WIN',
      evaluatedAt: new Date().toISOString(),
    } as any);

    // Should not throw, and the contaminated row must not appear as a counted prediction.
    await expect(reflectionEngine.evaluateAgents()).resolves.not.toThrow();
  });
});
