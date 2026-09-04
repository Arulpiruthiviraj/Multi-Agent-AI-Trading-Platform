import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

/**
 * Real integration test (isolated temp SQLite DB) for KronosMetrics.recordPrediction()'s
 * model-trust/dissimilarity-gate follow-up (2026-09-04): the real input-window feature columns
 * (inputRealizedVolatility/inputMeanAbsReturn/inputRangeRatio) must be persisted from the SAME
 * price series the prediction was actually made from, never fabricated when that window is too
 * thin to compute a real statistic from.
 */
describe('KronosMetrics.recordPrediction - input feature persistence', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let KronosMetrics: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_kronos_metrics_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../../db'));
    schema = await import('../../db/schema');
    ({ KronosMetrics } = await import('./KronosMetrics'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  const basePrediction = {
    symbol: 'AAPL', timeframe: '1m', prediction: 'BUY', confidence: 0.75,
    forecastHorizon: 5, expectedMove: '1.0%', volatility: '1.0%', support: 100, resistance: 110,
    model: 'test-model', predictedOHLC: [], timestamp: new Date().toISOString(),
  };

  it('persists real, non-null input-feature columns when the input window is long enough', async () => {
    const metrics = new KronosMetrics();
    const inputCloses = [100, 100.5, 99.8, 100.2, 100.9, 100.3];
    await metrics.recordPrediction(basePrediction as any, inputCloses);

    const [row] = await db.select().from(schema.kronosPredictions).where(eq(schema.kronosPredictions.symbol, 'AAPL'));
    expect(row).toBeTruthy();
    expect(row.inputRealizedVolatility).toBeGreaterThan(0);
    expect(row.inputMeanAbsReturn).toBeGreaterThan(0);
    expect(row.inputRangeRatio).toBeGreaterThan(0);
  });

  it('persists null (never fabricated) input-feature columns when the input window is too thin', async () => {
    const metrics = new KronosMetrics();
    await metrics.recordPrediction({ ...basePrediction, symbol: 'THIN' } as any, [100, 101]); // only 2 points

    const [row] = await db.select().from(schema.kronosPredictions).where(eq(schema.kronosPredictions.symbol, 'THIN'));
    expect(row).toBeTruthy();
    expect(row.inputRealizedVolatility).toBeNull();
    expect(row.inputMeanAbsReturn).toBeNull();
    expect(row.inputRangeRatio).toBeNull();
  });

  it('accepts candle-like objects (not just plain numbers) for the input window, same as the trajectory extraction already does', async () => {
    const metrics = new KronosMetrics();
    const candleLikeInput = [{ close: 100 }, { close: 100.4 }, { close: 99.9 }, { close: 100.6 }, { close: 100.1 }, { close: 100.7 }];
    await metrics.recordPrediction({ ...basePrediction, symbol: 'CANDLE' } as any, candleLikeInput);

    const [row] = await db.select().from(schema.kronosPredictions).where(eq(schema.kronosPredictions.symbol, 'CANDLE'));
    expect(row.inputRealizedVolatility).toBeGreaterThan(0);
  });
});
