/**
 * ==========================================================
 * Module: MultiHorizonOutcomeEvaluator
 *
 * Research Memory Platform Phase 2 (2026-09-12) - multi-horizon forward-outcome tracking
 * (mandate section 13: "Do NOT assume one universal horizon... store +1 bar / +5 bars / +20 bars
 * ... where appropriate"). Deliberately SEPARATE from PredictionOutcomeEvaluator.ts /
 * prediction_outcomes, which is the live, per-strategy-tuned single-horizon WIN/LOSS grade that
 * feeds agent_performance_stats.currentWeight (ChiefTrader weight learning) - that system is
 * correctly single-horizon by design and is left completely unmodified. This module answers a
 * different, additive research question: "how did the same real signal look at several fixed
 * bar offsets" - never read by weight learning, RiskEngine, ChiefTraderAgent, or OMS.
 *
 * Same honesty convention as PredictionOutcomeEvaluator.ts: a horizon whose bars have not yet
 * arrived is simply left unevaluated (no row, no fabricated value) and retried next cycle, not
 * given a synthetic zero or guessed value.
 * ==========================================================
 */
import { db } from '../db';
import { agentPredictions, kronosPredictions, predictionOutcomeHorizons } from '../db/schema';
import { historicalDataGateway } from '../engines/backtest/HistoricalDataGateway';
import { multiHorizonOutcomeTracking, type MultiHorizonDefinition } from '../config/multiHorizonOutcomeTracking';
import { TELEMETRY_PULSE_TRACE_PREFIX } from '../core/telemetryPulse';

export interface MultiHorizonOutcomeResult {
  horizonLabel: string;
  horizonBars: number;
  /** Direction-adjusted (positive = favorable for the prediction's own side), same convention as
   *  prediction_outcomes.mfe/mae - never the raw unsigned market return. */
  forwardReturn: number;
  /** Raw market direction (not side-adjusted). */
  forwardDirection: 'UP' | 'DOWN' | 'FLAT';
}

/**
 * Real bars-based multi-horizon evaluation for one prediction. Only ever evaluates horizons NOT
 * already present in `alreadyDoneLabels`. Returns an empty array (never a fabricated result) for
 * a non-directional side, a data-source failure, or when fewer bars exist than the smallest
 * still-missing horizon requires.
 */
export async function evaluateMultiHorizonOutcomesForPrediction(
  symbol: string,
  side: string,
  predictionTimeMs: number,
  alreadyDoneLabels: ReadonlySet<string>,
  horizons: MultiHorizonDefinition[] = multiHorizonOutcomeTracking.horizons,
): Promise<MultiHorizonOutcomeResult[]> {
  if (side !== 'BUY' && side !== 'SELL') return [];
  const missing = horizons.filter((h) => !alreadyDoneLabels.has(h.label));
  if (missing.length === 0) return [];

  const maxBars = Math.max(...missing.map((h) => h.bars));
  // +1 minute of buffer per bar - bars are '1Min' timeframe, so requesting exactly maxBars
  // minutes forward can land exactly on a boundary and short the fetch by one bar.
  const horizonEnd = predictionTimeMs + (maxBars + 1) * 60_000;

  let bars;
  try {
    bars = await historicalDataGateway.getBars(symbol, '1Min', predictionTimeMs, horizonEnd);
    if (bars.length < 2) {
      await historicalDataGateway.ensureBars(symbol, '1Min', predictionTimeMs, horizonEnd);
      bars = await historicalDataGateway.getBars(symbol, '1Min', predictionTimeMs, horizonEnd);
    }
  } catch {
    return []; // no real data source available - never fabricate
  }
  if (bars.length < 2) return [];

  const entryPrice = bars[0].close;
  if (entryPrice <= 0) return [];
  const isLong = side === 'BUY';

  const results: MultiHorizonOutcomeResult[] = [];
  for (const h of missing) {
    if (bars.length <= h.bars) continue; // insufficient real bars for this horizon yet - retry next cycle
    const barAtHorizon = bars[h.bars];
    const rawReturn = (barAtHorizon.close - entryPrice) / entryPrice;
    const forwardDirection: 'UP' | 'DOWN' | 'FLAT' =
      barAtHorizon.close > entryPrice ? 'UP' : barAtHorizon.close < entryPrice ? 'DOWN' : 'FLAT';
    results.push({
      horizonLabel: h.label,
      horizonBars: h.bars,
      forwardReturn: isLong ? rawReturn : -rawReturn,
      forwardDirection,
    });
  }
  return results;
}

export class MultiHorizonOutcomeEvaluator {
  private intervalId: NodeJS.Timeout | null = null;

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(
      () => this.evaluatePending().catch((e) => console.error('[MultiHorizonOutcomeEvaluator] Cycle failed', e)),
      multiHorizonOutcomeTracking.evaluationIntervalMs,
    );
    this.evaluatePending().catch((e) => console.error('[MultiHorizonOutcomeEvaluator] Initial cycle failed', e));
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async evaluatePending() {
    const allLabels = multiHorizonOutcomeTracking.horizons.map((h) => h.label);
    const existingRows = await db.select().from(predictionOutcomeHorizons).all();
    const doneLabelsByKey = new Map<string, Set<string>>();
    for (const row of existingRows) {
      const key = `${row.sourceTable}:${row.predictionId}`;
      if (!doneLabelsByKey.has(key)) doneLabelsByKey.set(key, new Set());
      doneLabelsByKey.get(key)!.add(row.horizonLabel);
    }

    const predictions = await db.select().from(agentPredictions).all();
    for (const p of predictions) {
      // Same exclusions as PredictionOutcomeEvaluator.ts, for the same reasons: KronosEngine's own
      // forecasts are evaluated once, cleanly, from kronos_predictions below; a Digital Twin
      // telemetry-pulse row must never be graded against real market data.
      if (p.agentName === 'KronosEngine') continue;
      if (p.traceId && p.traceId.startsWith(TELEMETRY_PULSE_TRACE_PREFIX)) continue;
      if (p.prediction !== 'BUY' && p.prediction !== 'SELL') continue;

      const key = `agent_predictions:${p.id}`;
      const done = doneLabelsByKey.get(key) ?? new Set<string>();
      if (done.size === allLabels.length) continue; // every horizon already recorded

      const predTime = new Date(p.timestamp).getTime();
      const results = await evaluateMultiHorizonOutcomesForPrediction(p.symbol, p.prediction, predTime, done);
      for (const r of results) {
        try {
          await db.insert(predictionOutcomeHorizons).values({
            predictionId: p.id,
            sourceTable: 'agent_predictions',
            symbol: p.symbol,
            horizonLabel: r.horizonLabel,
            horizonBars: r.horizonBars,
            forwardReturn: r.forwardReturn,
            forwardDirection: r.forwardDirection,
            evaluatedAt: new Date().toISOString(),
          }).onConflictDoNothing();
        } catch (e) {
          console.error('[MultiHorizonOutcomeEvaluator] Failed to persist horizon outcome', e);
        }
      }
    }

    const kronosRows = await db.select().from(kronosPredictions).all();
    for (const k of kronosRows) {
      if (k.prediction !== 'BUY' && k.prediction !== 'SELL') continue;
      const idStr = String(k.id);
      const key = `kronos_predictions:${idStr}`;
      const done = doneLabelsByKey.get(key) ?? new Set<string>();
      if (done.size === allLabels.length) continue;

      const predTime = new Date(k.timestamp).getTime();
      const results = await evaluateMultiHorizonOutcomesForPrediction(k.symbol, k.prediction, predTime, done);
      for (const r of results) {
        try {
          await db.insert(predictionOutcomeHorizons).values({
            predictionId: idStr,
            sourceTable: 'kronos_predictions',
            symbol: k.symbol,
            horizonLabel: r.horizonLabel,
            horizonBars: r.horizonBars,
            forwardReturn: r.forwardReturn,
            forwardDirection: r.forwardDirection,
            evaluatedAt: new Date().toISOString(),
          }).onConflictDoNothing();
        } catch (e) {
          console.error('[MultiHorizonOutcomeEvaluator] Failed to persist horizon outcome', e);
        }
      }
    }
  }
}

export const multiHorizonOutcomeEvaluator = new MultiHorizonOutcomeEvaluator();
