import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../db';
import * as schema from '../../db/schema';
import { getKronosHistoricalMetrics, getKronosLatestForecast } from './KronosDashboardData';

describe('KronosDashboardData', () => {
  beforeEach(async () => {
    await db.delete(schema.predictionOutcomes);
    await db.delete(schema.kronosPredictions);
    await db.delete(schema.agentPredictions);
  });

  it('returns honest DATA_UNAVAILABLE-shaped nulls when no outcomes exist', async () => {
    const m = await getKronosHistoricalMetrics();
    expect(m.sampleSize).toBe(0);
    expect(m.directionalAccuracy).toBeNull();
    expect(m.mae).toBeNull();
    expect(m.source).toBe('none');
    expect(m.unavailableReason).toBeTruthy();
  });

  it('computes directional accuracy + MAE/RMSE/MAPE from real prediction_outcomes', async () => {
    const [row] = await db.insert(schema.kronosPredictions).values({
      symbol: 'AAPL',
      timeframe: 'tick',
      prediction: 'BUY',
      confidence: 0.7,
      forecastHorizon: 5,
      expectedMove: '1.00%',
      volatility: '0.50%',
      support: 99,
      resistance: 102,
      model: 'chronos-test',
      predictedOhlc: JSON.stringify([{ close: 101, low: 100, high: 102 }]),
      marketStructure: 'Unknown',
      momentum: 'bullish',
      timestamp: new Date(Date.now() - 3_600_000).toISOString(),
    }).returning();

    await db.insert(schema.predictionOutcomes).values({
      predictionId: String(row.id),
      sourceTable: 'kronos_predictions',
      symbol: 'AAPL',
      actualPrice: 100,
      actualReturn: 0.01,
      actualDirection: 'UP',
      mfe: 0.02,
      mae: -0.01,
      outcome: 'WIN',
      evaluatedAt: new Date().toISOString(),
    });

    const m = await getKronosHistoricalMetrics();
    expect(m.sampleSize).toBe(1);
    expect(m.directionalAccuracy).toBe(1);
    expect(m.mae).toBeCloseTo(1, 5); // |101 - 100|
    expect(m.rmse).toBeCloseTo(1, 5);
    expect(m.mape).toBeCloseTo(1, 5); // 1%
    expect(m.source).toBe('prediction_outcomes');
  });

  it('returns latest forecast series for chart from kronos_predictions', async () => {
    await db.insert(schema.kronosPredictions).values({
      symbol: 'MSFT',
      timeframe: 'tick',
      prediction: 'SELL',
      confidence: 0.6,
      forecastHorizon: 3,
      expectedMove: '-0.50%',
      volatility: '1.00%',
      support: 400,
      resistance: 410,
      model: 'chronos-test',
      predictedOhlc: JSON.stringify([
        { close: 405, low: 403, high: 407 },
        { close: 404, low: 402, high: 406 },
        { close: 403, low: 401, high: 405 },
      ]),
      timestamp: new Date().toISOString(),
    });

    const fc = await getKronosLatestForecast('MSFT');
    expect(fc.available).toBe(true);
    expect(fc.symbol).toBe('MSFT');
    expect(fc.series).toHaveLength(3);
    expect(fc.series[2].median).toBe(403);
    expect(fc.unavailableReason).toBeNull();
  });

  it('reports unavailable honestly when no forecast rows exist', async () => {
    const fc = await getKronosLatestForecast('ZZZZ');
    expect(fc.available).toBe(false);
    expect(fc.series).toEqual([]);
    expect(fc.unavailableReason).toMatch(/No Kronos forecast/);
  });
});
