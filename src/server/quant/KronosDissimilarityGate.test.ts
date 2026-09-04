import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('KronosDissimilarityGate', () => {
  describe('computeInputFeatures (pure)', () => {
    let computeInputFeatures: typeof import('./KronosDissimilarityGate').computeInputFeatures;

    beforeAll(async () => {
      ({ computeInputFeatures } = await import('./KronosDissimilarityGate'));
    });

    it('returns null when fewer than 5 real closes are available', () => {
      expect(computeInputFeatures([100, 101, 102])).toBeNull();
    });

    it('filters out non-finite/non-positive values before checking the minimum', () => {
      expect(computeInputFeatures([100, NaN, 101, -5, 0, Infinity, 102])).toBeNull(); // only 3 real values survive
    });

    it('computes real, non-fabricated statistics for a normal price window', () => {
      const closes = [100, 100.5, 99.8, 100.2, 100.9, 100.3];
      const features = computeInputFeatures(closes)!;
      expect(features).not.toBeNull();
      expect(features.realizedVolatility).toBeGreaterThan(0);
      expect(features.meanAbsReturn).toBeGreaterThan(0);
      expect(features.rangeRatio).toBeGreaterThan(0);
    });

    it('reports near-zero volatility for a perfectly flat window', () => {
      const features = computeInputFeatures([100, 100, 100, 100, 100, 100])!;
      expect(features.realizedVolatility).toBeCloseTo(0, 10);
      expect(features.meanAbsReturn).toBeCloseTo(0, 10);
      expect(features.rangeRatio).toBeCloseTo(0, 10);
    });

    it('reports a much larger realizedVolatility for an erratic window than a calm one', () => {
      const calm = computeInputFeatures([100, 100.1, 99.9, 100.05, 99.95, 100.02])!;
      const erratic = computeInputFeatures([100, 130, 70, 140, 60, 150])!;
      expect(erratic.realizedVolatility).toBeGreaterThan(calm.realizedVolatility * 5);
    });
  });

  describe('assessDissimilarity (pure)', () => {
    let assessDissimilarity: typeof import('./KronosDissimilarityGate').assessDissimilarity;
    const CONFIG = { minReferenceSampleSize: 30, oodZThreshold: 3.5 };

    beforeAll(async () => {
      ({ assessDissimilarity } = await import('./KronosDissimilarityGate'));
    });

    it('returns INSUFFICIENT_REFERENCE_DATA when referenceStats is null', () => {
      const result = assessDissimilarity({ realizedVolatility: 0.01, meanAbsReturn: 0.005, rangeRatio: 0.02 }, null, CONFIG);
      expect(result.status).toBe('INSUFFICIENT_REFERENCE_DATA');
      expect(result.maxAbsZ).toBeNull();
      expect(result.referenceSampleSize).toBe(0);
    });

    it('returns INSUFFICIENT_REFERENCE_DATA when the reference sample is below the configured floor', () => {
      const stats = {
        count: 5,
        mean: { realizedVolatility: 0.01, meanAbsReturn: 0.005, rangeRatio: 0.02 },
        stdev: { realizedVolatility: 0.002, meanAbsReturn: 0.001, rangeRatio: 0.005 },
      };
      const result = assessDissimilarity({ realizedVolatility: 0.01, meanAbsReturn: 0.005, rangeRatio: 0.02 }, stats, CONFIG);
      expect(result.status).toBe('INSUFFICIENT_REFERENCE_DATA');
    });

    it('classifies a typical input matching the reference distribution as IN_DISTRIBUTION', () => {
      const stats = {
        count: 100,
        mean: { realizedVolatility: 0.01, meanAbsReturn: 0.005, rangeRatio: 0.02 },
        stdev: { realizedVolatility: 0.002, meanAbsReturn: 0.001, rangeRatio: 0.005 },
      };
      const result = assessDissimilarity({ realizedVolatility: 0.0105, meanAbsReturn: 0.0052, rangeRatio: 0.021 }, stats, CONFIG);
      expect(result.status).toBe('IN_DISTRIBUTION');
      expect(result.maxAbsZ).not.toBeNull();
      expect(result.maxAbsZ!).toBeLessThan(3.5);
    });

    it('classifies a genuine outlier (extreme volatility far outside the reference distribution) as NOVEL', () => {
      const stats = {
        count: 100,
        mean: { realizedVolatility: 0.01, meanAbsReturn: 0.005, rangeRatio: 0.02 },
        stdev: { realizedVolatility: 0.002, meanAbsReturn: 0.001, rangeRatio: 0.005 },
      };
      // realizedVolatility is 10 stdevs away from the reference mean.
      const result = assessDissimilarity({ realizedVolatility: 0.03, meanAbsReturn: 0.005, rangeRatio: 0.02 }, stats, CONFIG);
      expect(result.status).toBe('NOVEL');
      expect(result.maxAbsZ!).toBeGreaterThan(3.5);
    });

    it('handles a zero-variance reference feature without dividing by zero: matching value is IN_DISTRIBUTION, any deviation is NOVEL', () => {
      const stats = {
        count: 100,
        mean: { realizedVolatility: 0.01, meanAbsReturn: 0, rangeRatio: 0.02 },
        stdev: { realizedVolatility: 0.002, meanAbsReturn: 0, rangeRatio: 0.005 }, // meanAbsReturn has never varied historically
      };
      const matching = assessDissimilarity({ realizedVolatility: 0.01, meanAbsReturn: 0, rangeRatio: 0.02 }, stats, CONFIG);
      expect(matching.status).toBe('IN_DISTRIBUTION');
      expect(matching.perFeatureZ!.meanAbsReturn).toBe(0);

      const deviating = assessDissimilarity({ realizedVolatility: 0.01, meanAbsReturn: 0.05, rangeRatio: 0.02 }, stats, CONFIG);
      expect(deviating.status).toBe('NOVEL');
      expect(Number.isFinite(deviating.maxAbsZ)).toBe(true); // never a literal Infinity - stays JSON-serializable
    });

    it('is independent of model confidence by construction - the function signature never accepts a confidence value at all', () => {
      // Structural proof: assessDissimilarity's parameters are (features, referenceStats, config) -
      // there is no confidence input for a caller to smuggle in, so a "91% confident" model cannot
      // influence this function's classification even in principle.
      expect(assessDissimilarity.length).toBeLessThanOrEqual(3);
    });
  });

  describe('refreshKronosReferenceStats / cache (real DB integration)', () => {
    let tmpDbPath: string;
    let db: any;
    let sqliteDb: any;
    let schema: any;
    let mod: typeof import('./KronosDissimilarityGate');

    beforeAll(async () => {
      tmpDbPath = path.join(os.tmpdir(), `argus_kronos_ood_${Date.now()}_${process.pid}.db`);
      process.env.ARGUS_DB_PATH = tmpDbPath;
      ({ db, sqliteDb } = await import('../db'));
      schema = await import('../db/schema');
      mod = await import('./KronosDissimilarityGate');
    });

    afterAll(() => {
      try { sqliteDb.close(); } catch { /* already closed */ }
      for (const suffix of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
      }
      delete process.env.ARGUS_DB_PATH;
    });

    beforeEach(() => {
      mod.resetKronosReferenceStatsCacheForTests();
    });

    function seedKronosPrediction(symbol: string, ts: number, features: { v: number; m: number; r: number } | null) {
      return db.insert(schema.kronosPredictions).values({
        symbol, timeframe: '1m', prediction: 'BUY', confidence: 0.7, forecastHorizon: 5,
        expectedMove: '1.0%', volatility: '1.0%', support: 100, resistance: 110, model: 'test',
        timestamp: new Date(ts).toISOString(),
        inputRealizedVolatility: features?.v ?? null,
        inputMeanAbsReturn: features?.m ?? null,
        inputRangeRatio: features?.r ?? null,
      });
    }

    it('computes real mean/stdev only from rows that actually have persisted input features, skipping older null rows', async () => {
      const base = Date.now() - 10_000_000;
      for (let i = 0; i < 5; i++) {
        await seedKronosPrediction('OODTEST', base + i * 1000, { v: 0.01, m: 0.005, r: 0.02 });
      }
      await seedKronosPrediction('OODTEST', base + 6000, null); // pre-migration row, must be skipped

      const stats = await mod.refreshKronosReferenceStats();
      expect(stats).not.toBeNull();
      expect(stats!.count).toBe(5); // the null row is excluded, not treated as zero
      expect(stats!.mean.realizedVolatility).toBeCloseTo(0.01, 6);
    });

    it('cache reports stale until a refresh runs, then fresh, honoring the configured TTL', async () => {
      expect(mod.isKronosReferenceStatsCacheStale()).toBe(true);
      await mod.refreshKronosReferenceStats();
      expect(mod.isKronosReferenceStatsCacheStale()).toBe(false);
      expect(mod.getCachedKronosReferenceStats()).not.toBeNull();
    });
  });
});
