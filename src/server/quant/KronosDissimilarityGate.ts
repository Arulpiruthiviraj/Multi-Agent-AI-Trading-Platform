/**
 * Model-trust / dissimilarity gate (2026-09-04, Freqtrade FreqAI Dissimilarity Index follow-up -
 * see docs/audits/ under the same date for the source comparison). Kronos (Chronos-T5, via
 * KronosInference.ts) is the one real trained learned-model path in Argus's live idea pipeline.
 * Its own `confidence` field describes only how tight the model's OWN forecast quantiles are
 * (KronosInference.ts's `buildPrediction()`) - it says nothing about whether the INPUT price
 * window looks anything like what the model has actually been queried on before. A model can be
 * "confident" while extrapolating on an input regime it has never really been exercised against.
 *
 * This module answers a narrower, honest question instead: is the CURRENT input window's own
 * short-term statistical shape (realized volatility, mean absolute return, high/low range ratio -
 * all real, computed directly from the same real price series Kronos was actually called with)
 * unusual relative to the SAME statistics computed for Argus's own past Kronos calls? This is a
 * proxy for "in-distribution vs novel", not a claim about Chronos's actual pretraining data (which
 * Argus does not have access to) - documented honestly as a proxy, never conflated with the real
 * training distribution.
 *
 * Deliberately mirrors StrategyScoreNormalizer.ts's own cache/refresh/pure-assessment split (the
 * closest existing precedent for a z-score-against-own-history feature in this codebase) rather
 * than inventing a new pattern. Deliberately pure TypeScript, not quant-core-java: this is a
 * low-frequency (per-Kronos-call, itself cooldown-limited to roughly one call per symbol per
 * several minutes), non-performance-critical statistical check over at most a few hundred
 * historical rows - not the high-throughput/parallelizable numerical work the Java engine
 * authority section of CLAUDE.md targets, and no performance claim motivates moving it.
 *
 * Read-only, observational math only. Never imports ChiefTraderAgent/RiskEngine/OMS/BrokerManager.
 * The live wiring point (KronosForecastAgent.ts) uses this module's output to decide only whether
 * to skip publishing a live idea for one forecast - it never touches RiskEngine, OMS, or consensus
 * itself, and the underlying forecast is still persisted regardless (research value is never
 * suppressed).
 */
import { db } from '../db';
import { kronosPredictions } from '../db/schema';
import { desc, isNotNull } from 'drizzle-orm';
import { kronosDissimilarityGate } from '../config/kronosDissimilarityGate';

export interface KronosInputFeatures {
  realizedVolatility: number;
  meanAbsReturn: number;
  rangeRatio: number;
}

const FEATURE_KEYS: Array<keyof KronosInputFeatures> = ['realizedVolatility', 'meanAbsReturn', 'rangeRatio'];

// Any per-feature z-score is capped at this before being reported - real deviations beyond this are
// still classified NOVEL, but the raw number is capped so it can never serialize to Infinity
// (JSON.stringify(Infinity) silently becomes null, which would erase the very evidence a NOVEL
// classification needs to be reviewable).
const Z_SENTINEL_CAP = 999;

/**
 * Pure - no I/O. Real sample statistics from the SAME closing-price series Kronos was actually
 * given (closes.length already validated by KronosInference.predict() to be >= 5 before this is
 * ever called for a live gate check; this function re-validates independently since it is also
 * unit-tested and called from KronosMetrics.recordPrediction() directly). Returns null (never a
 * fabricated result) when fewer than 5 finite, positive closes are available - mirrors
 * KronosInference.ts's own real minimum for a meaningful time-series read.
 */
export function computeInputFeatures(closes: number[]): KronosInputFeatures | null {
  const values = closes.filter((c) => typeof c === 'number' && Number.isFinite(c) && c > 0);
  if (values.length < 5) return null;

  const logReturns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    logReturns.push(Math.log(values[i] / values[i - 1]));
  }
  const meanReturn = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const meanAbsReturn = logReturns.reduce((a, b) => a + Math.abs(b), 0) / logReturns.length;
  // Sample standard deviation (n-1) - real returns population is unknown, this is an estimate from
  // the one real window we have, same convention as every other Wilson/effective-N estimator in
  // this codebase treating an observed sample as an estimate, not a population parameter.
  const variance = logReturns.length > 1
    ? logReturns.reduce((acc, r) => acc + (r - meanReturn) ** 2, 0) / (logReturns.length - 1)
    : 0;
  const realizedVolatility = Math.sqrt(Math.max(0, variance));

  const max = Math.max(...values);
  const min = Math.min(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const rangeRatio = mean > 0 ? (max - min) / mean : 0;

  return { realizedVolatility, meanAbsReturn, rangeRatio };
}

export interface KronosReferenceStats {
  count: number;
  mean: Record<keyof KronosInputFeatures, number>;
  stdev: Record<keyof KronosInputFeatures, number>;
}

let statsCache: { fetchedAt: number; stats: KronosReferenceStats } | null = null;
let inFlight = false;

/**
 * Real aggregation over already-persisted kronos_predictions.input* columns (no new table),
 * bounded to the most recent maxReferenceSampleSize rows that actually have them (older rows
 * predate this feature and are simply skipped, never fabricated). Cross-symbol/global reference
 * population by design for this first pass - a real, honestly-documented limitation (not yet
 * per-symbol or per-regime), named because there is not yet enough per-symbol Kronos history for a
 * per-symbol reference distribution to be statistically meaningful on its own.
 *
 * Never throws - any failure here fails closed to the existing cache (or null on first run), which
 * the live gate treats as INSUFFICIENT_REFERENCE_DATA, never a crash and never a fabricated stat.
 */
export async function refreshKronosReferenceStats(): Promise<KronosReferenceStats | null> {
  if (inFlight) return statsCache?.stats ?? null;
  inFlight = true;
  try {
    const rows = await db.select({
      realizedVolatility: kronosPredictions.inputRealizedVolatility,
      meanAbsReturn: kronosPredictions.inputMeanAbsReturn,
      rangeRatio: kronosPredictions.inputRangeRatio,
    })
      .from(kronosPredictions)
      .where(isNotNull(kronosPredictions.inputRealizedVolatility))
      .orderBy(desc(kronosPredictions.id))
      .limit(kronosDissimilarityGate.maxReferenceSampleSize);

    const sum: Record<keyof KronosInputFeatures, number> = { realizedVolatility: 0, meanAbsReturn: 0, rangeRatio: 0 };
    const sumSq: Record<keyof KronosInputFeatures, number> = { realizedVolatility: 0, meanAbsReturn: 0, rangeRatio: 0 };
    let count = 0;
    for (const r of rows) {
      if (typeof r.realizedVolatility !== 'number' || typeof r.meanAbsReturn !== 'number' || typeof r.rangeRatio !== 'number') continue;
      if (!Number.isFinite(r.realizedVolatility) || !Number.isFinite(r.meanAbsReturn) || !Number.isFinite(r.rangeRatio)) continue;
      sum.realizedVolatility += r.realizedVolatility;
      sum.meanAbsReturn += r.meanAbsReturn;
      sum.rangeRatio += r.rangeRatio;
      sumSq.realizedVolatility += r.realizedVolatility ** 2;
      sumSq.meanAbsReturn += r.meanAbsReturn ** 2;
      sumSq.rangeRatio += r.rangeRatio ** 2;
      count += 1;
    }
    if (count === 0) {
      statsCache = { fetchedAt: Date.now(), stats: { count: 0, mean: sum, stdev: sum } };
      return statsCache.stats;
    }
    const mean = {} as Record<keyof KronosInputFeatures, number>;
    const stdev = {} as Record<keyof KronosInputFeatures, number>;
    for (const key of FEATURE_KEYS) {
      mean[key] = sum[key] / count;
      const variance = Math.max(0, sumSq[key] / count - mean[key] ** 2);
      stdev[key] = Math.sqrt(variance);
    }
    const stats: KronosReferenceStats = { count, mean, stdev };
    statsCache = { fetchedAt: Date.now(), stats };
    return stats;
  } catch (e) {
    console.error('[KronosDissimilarityGate] refresh failed - falling back to the existing cache (or null, treated as INSUFFICIENT_REFERENCE_DATA)', e);
    return statsCache?.stats ?? null;
  } finally {
    inFlight = false;
  }
}

/** Synchronous read of whatever the last refresh produced. Null until a refresh has run. */
export function getCachedKronosReferenceStats(): KronosReferenceStats | null {
  return statsCache?.stats ?? null;
}

export function isKronosReferenceStatsCacheStale(): boolean {
  if (!statsCache) return true;
  return Date.now() - statsCache.fetchedAt > kronosDissimilarityGate.referenceStatsCacheTtlMs;
}

/** Test-only reset so each test file starts from a clean cache. */
export function resetKronosReferenceStatsCacheForTests(): void {
  statsCache = null;
  inFlight = false;
}

export type DissimilarityStatus = 'IN_DISTRIBUTION' | 'NOVEL' | 'INSUFFICIENT_REFERENCE_DATA';

export interface DissimilarityAssessment {
  status: DissimilarityStatus;
  maxAbsZ: number | null;
  perFeatureZ: Record<keyof KronosInputFeatures, number> | null;
  referenceSampleSize: number;
}

/**
 * Pure - no I/O. Independent of model confidence by construction: this function never receives or
 * reads Kronos's own confidence value, so nothing about how "sure" the model claims to be can
 * override a NOVEL classification here - the whole point of an out-of-distribution check.
 */
export function assessDissimilarity(
  features: KronosInputFeatures,
  referenceStats: KronosReferenceStats | null,
  config: Pick<typeof kronosDissimilarityGate, 'minReferenceSampleSize' | 'oodZThreshold'> = kronosDissimilarityGate,
): DissimilarityAssessment {
  if (!referenceStats || referenceStats.count < config.minReferenceSampleSize) {
    return { status: 'INSUFFICIENT_REFERENCE_DATA', maxAbsZ: null, perFeatureZ: null, referenceSampleSize: referenceStats?.count ?? 0 };
  }

  const perFeatureZ = {} as Record<keyof KronosInputFeatures, number>;
  for (const key of FEATURE_KEYS) {
    const mean = referenceStats.mean[key];
    const stdev = referenceStats.stdev[key];
    const value = features[key];
    if (stdev === 0) {
      perFeatureZ[key] = value === mean ? 0 : Z_SENTINEL_CAP;
    } else {
      perFeatureZ[key] = Math.min(Z_SENTINEL_CAP, Math.abs((value - mean) / stdev));
    }
  }
  const maxAbsZ = Math.max(...FEATURE_KEYS.map((k) => perFeatureZ[k]));
  const status: DissimilarityStatus = maxAbsZ > config.oodZThreshold ? 'NOVEL' : 'IN_DISTRIBUTION';
  return { status, maxAbsZ, perFeatureZ, referenceSampleSize: referenceStats.count };
}
