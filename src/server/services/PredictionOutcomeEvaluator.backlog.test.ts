import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tradingSafety } from '../config/tradingSafety';

// Real isolated SQLite, real evaluator and outcome calculation. Only unavailable provider
// backfill is controlled; no signals, approvals or outcome rows are injected.
describe('Prediction outcome pending-page fairness', () => {
  let sqliteDb: any, db: any, schema: any, Evaluator: any, gateway: any;
  let fixturePath: string;
  const origin = Date.parse('2026-01-05T14:30:00.000Z');
  beforeAll(async () => {
    fixturePath = path.join(os.tmpdir(), `argus_outcome_pages_${process.pid}_${Date.now()}.db`);
    process.env.ARGUS_DB_PATH = fixturePath;
    ({ sqliteDb, db } = await import('../db'));
    schema = await import('../db/schema');
    ({ PredictionOutcomeEvaluator: Evaluator } = await import('./PredictionOutcomeEvaluator'));
    ({ historicalDataGateway: gateway } = await import('../engines/backtest/HistoricalDataGateway'));
    vi.spyOn(gateway, 'ensureBars').mockResolvedValue(undefined);
  });
  beforeEach(() => {
    sqliteDb.exec('DELETE FROM prediction_outcomes; DELETE FROM agent_predictions; DELETE FROM kronos_predictions; DELETE FROM news_predictions; DELETE FROM ohlcv_bars;');
  });
  afterAll(() => {
    vi.restoreAllMocks();
    sqliteDb.close();
    delete process.env.ARGUS_DB_PATH;
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(fixturePath + suffix); } catch { /* fixture cleanup */ }
    }
  });

  it.each([false, true])('advances past unavailable pages and revisits them (timestamp ties: %s)', async tied => {
    const size = tradingSafety.predictionOutcomeBatchSize;
    const recent = tied ? origin : origin + 60_000;
    const oldTimestamp = new Date(origin).toISOString();
    const recentTimestamp = new Date(recent).toISOString();
    const agents = [], kronos = [], news = [];
    for (let index = 0; index <= size; index++) {
      const good = index === size;
      const id = good ? 'zz-complete' : `a-${String(index).padStart(8, '0')}`;
      const symbol = good ? 'AAPL' : 'VOID';
      const timestamp = good ? recentTimestamp : oldTimestamp;
      agents.push({ id, agentName: 'TechnicalAgent', symbol, timestamp,
        prediction: 'BUY', confidence: 0.8, reasoning: 'fixture' });
      kronos.push({ symbol, timestamp, timeframe: '1Min', prediction: 'BUY', confidence: 0.8,
        forecastHorizon: 5, expectedMove: '0.01', volatility: 'NORMAL', support: 95,
        resistance: 115, model: 'fixture' });
      news.push({ id, clusterId: id, traceId: id, symbol, createdAt: timestamp,
        direction: 'BULLISH', confidence: 80, expectedHorizon: 'INTRADAY',
        newsAgentMode: 'ACTIVE_OBSERVE', modelSource: 'fixture' });
    }
    for (let index = 0; index < agents.length; index += 500) {
      await db.insert(schema.agentPredictions).values(agents.slice(index, index + 500));
      await db.insert(schema.kronosPredictions).values(kronos.slice(index, index + 500));
      await db.insert(schema.newsPredictions).values(news.slice(index, index + 500));
    }
    const endpoints = new Set([recent, recent + tradingSafety.evaluationHorizonMs,
      recent + tradingSafety.kronosEvaluationHorizonMs,
      recent + tradingSafety.newsPredictionEvalIntradayMs]);
    await db.insert(schema.ohlcvBars).values([...endpoints].map(timestamp => ({
      id: `AAPL:1Min:${timestamp}`, symbol: 'AAPL', timeframe: '1Min', timestamp,
      open: timestamp === recent ? 100 : 110, high: timestamp === recent ? 100 : 110,
      low: timestamp === recent ? 100 : 110, close: timestamp === recent ? 100 : 110,
      volume: 1000, source: 'test',
    })));
    const worker = new Evaluator();
    await worker.evaluatePending();
    expect(worker.getMetrics().lastCycle.rowsFetched).toBe(size * 3);
    expect(worker.getMetrics().lastCycle.rowsWritten).toBe(0);
    await worker.evaluatePending();
    const outcomes = await db.select().from(schema.predictionOutcomes);
    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((row: any) => row.symbol === 'AAPL' && row.outcome === 'WIN')).toBe(true);
    expect(worker.getMetrics().lastCycle.rowsFetched).toBe(3);
    // An end-of-sweep wrap revisits still-unavailable predictions, without duplicate outcomes.
    await worker.evaluatePending();
    expect(worker.getMetrics().lastCycle.rowsFetched).toBe(size * 3);
    expect(worker.getMetrics().lastCycle.rowsWritten).toBe(0);
    expect(worker.getMetrics().scanAfter.agent.id).toBe(`a-${String(size - 1).padStart(8, '0')}`);
    expect((await db.select().from(schema.predictionOutcomes))).toHaveLength(3);
    // Restart resets only scheduling hints; all unresolved rows remain durable candidates.
    const restarted = new Evaluator();
    await restarted.evaluatePending();
    expect(restarted.getMetrics().lastCycle.rowsFetched).toBe(size * 3);
    expect(restarted.getMetrics().lastCycle.rowsWritten).toBe(0);
  }, tradingSafety.predictionOutcomeMaxCycleWallClockMs);

  it('gives another ledger first turn after a provider consumes the cycle budget', async () => {
    const timestamp = new Date(origin).toISOString();
    await db.insert(schema.agentPredictions).values({ id: 'blocked-agent', agentName: 'TechnicalAgent',
      symbol: 'BLOCKED', timestamp, prediction: 'BUY', confidence: 0.8, reasoning: 'fixture' });
    await db.insert(schema.kronosPredictions).values({ symbol: 'READY', timestamp,
      timeframe: '1Min', prediction: 'BUY', confidence: 0.8, forecastHorizon: 5,
      expectedMove: '0.01', volatility: 'NORMAL', support: 95, resistance: 115, model: 'fixture' });
    await db.insert(schema.newsPredictions).values({ id: 'ready-news', clusterId: 'ready-news',
      traceId: 'ready-news', symbol: 'READY', createdAt: timestamp, direction: 'BULLISH',
      confidence: 80, expectedHorizon: 'INTRADAY', newsAgentMode: 'ACTIVE_OBSERVE', modelSource: 'fixture' });
    await db.insert(schema.ohlcvBars).values([origin, origin + tradingSafety.kronosEvaluationHorizonMs,
      origin + tradingSafety.newsPredictionEvalIntradayMs].map(time => ({
      id: `READY:1Min:${time}`, symbol: 'READY', timeframe: '1Min', timestamp: time,
      open: time === origin ? 100 : 110, high: time === origin ? 100 : 110,
      low: time === origin ? 100 : 110, close: time === origin ? 100 : 110, volume: 1000, source: 'test',
    })));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T20:00:00.000Z'));
    let delayed = false;
    vi.mocked(gateway.ensureBars).mockImplementation(async () => {
      if (!delayed) {
        delayed = true;
        vi.setSystemTime(Date.now() + tradingSafety.predictionOutcomeMaxCycleWallClockMs + 1);
      }
    });
    try {
      const worker = new Evaluator();
      await worker.evaluatePending();
      expect(worker.getMetrics().lastCycle.bailedOnWallClock).toBe(true);
      expect(worker.getMetrics().lastCycle.rowsRemainingComplete).toBe(false);
      expect(worker.getMetrics().nextSource).toBe('kronos_predictions');
      expect((await db.select().from(schema.predictionOutcomes))).toHaveLength(0);
      await worker.evaluatePending();
      const outcomes = await db.select().from(schema.predictionOutcomes);
      expect(outcomes).toHaveLength(2);
      expect(outcomes.every((row: any) => row.symbol === 'READY' && row.outcome === 'WIN')).toBe(true);
      expect(worker.getMetrics().lastCycle.rowsRemainingComplete).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.mocked(gateway.ensureBars).mockResolvedValue(undefined);
    }
  });
});
