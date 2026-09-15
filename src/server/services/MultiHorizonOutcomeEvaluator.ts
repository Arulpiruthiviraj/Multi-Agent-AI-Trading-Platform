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
import { and, eq, inArray, isNull, ne, notLike, or, asc, sql } from 'drizzle-orm';
import { historicalDataGateway } from '../engines/backtest/HistoricalDataGateway';
import { multiHorizonOutcomeTracking, type MultiHorizonDefinition } from '../config/multiHorizonOutcomeTracking';
import { TELEMETRY_PULSE_TRACE_PREFIX } from '../core/telemetryPulse';
import { createSingleFlightGuard, type SingleFlightGuard, type SingleFlightIntervalMetrics } from '../core/singleFlightInterval';

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

export interface MultiHorizonOutcomeEvaluatorCycleStats {
  rowsFetched: number;
  rowsProcessed: number;
  rowsWritten: number;
  batches: number;
  bailedOnWallClock: boolean;
  /** True backlog size (COUNT(*) against the same pending condition, not just this cycle's bounded
   *  fetch window) - see PredictionOutcomeEvaluator.ts's identical field for the full rationale. */
  rowsRemaining: number;
}

const EMPTY_CYCLE_STATS: MultiHorizonOutcomeEvaluatorCycleStats = {
  rowsFetched: 0, rowsProcessed: 0, rowsWritten: 0, batches: 0, bailedOnWallClock: false, rowsRemaining: 0,
};

export class MultiHorizonOutcomeEvaluator {
  private intervalId: NodeJS.Timeout | null = null;
  // P1-A remediation (2026-09-14) - see PredictionOutcomeEvaluator.ts's identical comment: the
  // guard is intrinsic to evaluatePending() itself, protecting every caller, not just the timer.
  private guard: SingleFlightGuard = createSingleFlightGuard((e) => console.error('[MultiHorizonOutcomeEvaluator] Cycle failed', e));
  private lastCycleStats: MultiHorizonOutcomeEvaluatorCycleStats = EMPTY_CYCLE_STATS;

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => { void this.evaluatePending(); }, multiHorizonOutcomeTracking.evaluationIntervalMs);
    void this.evaluatePending();
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getMetrics(): SingleFlightIntervalMetrics & { lastCycle: MultiHorizonOutcomeEvaluatorCycleStats } {
    return { ...this.guard.getMetrics(), lastCycle: this.lastCycleStats };
  }

  async evaluatePending(): Promise<void> {
    await this.guard.run(() => this.runCycle());
  }

  private async runCycle(): Promise<void> {
    const cycleStart = Date.now();
    const allLabels = multiHorizonOutcomeTracking.horizons.map((h) => h.label);
    // horizons are sorted ascending by bars (multiHorizonOutcomeTracking.ts) - the largest label is
    // the last one. A prediction is only "fully done" once every horizon has a row, but bars for
    // every smaller horizon always arrive no later than bars for the largest one (they share one
    // fetch window sized to the largest missing horizon - see evaluateMultiHorizonOutcomesForPrediction
    // above), so "missing the largest label" is a correct, SQL-pushable proxy for "still needs work"
    // - never a false negative that would skip a row that actually still has pending horizons.
    const largestLabel = allLabels[allLabels.length - 1];
    const batchSize = multiHorizonOutcomeTracking.batchSize;
    const maxWallClockMs = multiHorizonOutcomeTracking.maxCycleWallClockMs;
    const stats: MultiHorizonOutcomeEvaluatorCycleStats = { rowsFetched: 0, rowsProcessed: 0, rowsWritten: 0, batches: 0, bailedOnWallClock: false, rowsRemaining: 0 };
    const outOfTime = () => Date.now() - cycleStart > maxWallClockMs;

    // P1-A remediation (2026-09-14) - see PredictionOutcomeEvaluator.ts's identical rationale
    // comment for why this is a bounded anti-join (never a monotonic watermark) and why the
    // always-skipped categories (KronosEngine rows here, HOLD predictions, telemetry-pulse rows)
    // must be excluded in SQL, not just in the loop body below - otherwise they permanently occupy
    // batch slots on every future cycle since this evaluator never writes a row for them.
    const agentJoinCondition = and(
      eq(predictionOutcomeHorizons.predictionId, agentPredictions.id),
      eq(predictionOutcomeHorizons.sourceTable, 'agent_predictions'),
      eq(predictionOutcomeHorizons.horizonLabel, largestLabel),
    );
    const agentPendingCondition = and(
      isNull(predictionOutcomeHorizons.id),
      ne(agentPredictions.agentName, 'KronosEngine'),
      or(eq(agentPredictions.prediction, 'BUY'), eq(agentPredictions.prediction, 'SELL')),
      or(isNull(agentPredictions.traceId), notLike(agentPredictions.traceId, `${TELEMETRY_PULSE_TRACE_PREFIX}%`)),
    );
    const pendingAgent = await db
      .select({ p: agentPredictions })
      .from(agentPredictions)
      .leftJoin(predictionOutcomeHorizons, agentJoinCondition)
      .where(agentPendingCondition)
      .orderBy(asc(agentPredictions.timestamp))
      .limit(batchSize);
    stats.rowsFetched += pendingAgent.length;
    stats.batches += 1;
    const [{ count: agentRemainingCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(agentPredictions)
      .leftJoin(predictionOutcomeHorizons, agentJoinCondition)
      .where(agentPendingCondition);
    stats.rowsRemaining += agentRemainingCount;

    if (pendingAgent.length > 0) {
      // A prediction in this batch may already have SOME (not all) horizons recorded - fetch just
      // this bounded batch's own horizon rows (a small IN-clause query, not the full growing
      // predictionOutcomeHorizons table) to build the per-prediction "already done" set.
      const batchIds = pendingAgent.map(({ p }) => p.id);
      const existingHorizonRows = await db
        .select()
        .from(predictionOutcomeHorizons)
        .where(and(
          eq(predictionOutcomeHorizons.sourceTable, 'agent_predictions'),
          inArray(predictionOutcomeHorizons.predictionId, batchIds),
        ));
      const doneLabelsByPredictionId = new Map<string, Set<string>>();
      for (const row of existingHorizonRows) {
        if (!doneLabelsByPredictionId.has(row.predictionId)) doneLabelsByPredictionId.set(row.predictionId, new Set());
        doneLabelsByPredictionId.get(row.predictionId)!.add(row.horizonLabel);
      }

      for (const { p } of pendingAgent) {
        if (outOfTime()) { stats.bailedOnWallClock = true; break; }
        stats.rowsProcessed += 1;
        const done = doneLabelsByPredictionId.get(p.id) ?? new Set<string>();
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
            stats.rowsWritten += 1;
          } catch (e) {
            console.error('[MultiHorizonOutcomeEvaluator] Failed to persist horizon outcome', e);
          }
        }
      }
    }

    if (!outOfTime()) {
      const kronosJoinCondition = and(
        eq(predictionOutcomeHorizons.predictionId, kronosPredictions.id),
        eq(predictionOutcomeHorizons.sourceTable, 'kronos_predictions'),
        eq(predictionOutcomeHorizons.horizonLabel, largestLabel),
      );
      const kronosPendingCondition = and(
        isNull(predictionOutcomeHorizons.id),
        or(eq(kronosPredictions.prediction, 'BUY'), eq(kronosPredictions.prediction, 'SELL')),
      );
      const pendingKronos = await db
        .select({ k: kronosPredictions })
        .from(kronosPredictions)
        .leftJoin(predictionOutcomeHorizons, kronosJoinCondition)
        .where(kronosPendingCondition)
        .orderBy(asc(kronosPredictions.timestamp))
        .limit(batchSize);
      stats.rowsFetched += pendingKronos.length;
      stats.batches += 1;
      const [{ count: kronosRemainingCount }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(kronosPredictions)
        .leftJoin(predictionOutcomeHorizons, kronosJoinCondition)
        .where(kronosPendingCondition);
      stats.rowsRemaining += kronosRemainingCount;

      if (pendingKronos.length > 0) {
        const batchIds = pendingKronos.map(({ k }) => String(k.id));
        const existingHorizonRows = await db
          .select()
          .from(predictionOutcomeHorizons)
          .where(and(
            eq(predictionOutcomeHorizons.sourceTable, 'kronos_predictions'),
            inArray(predictionOutcomeHorizons.predictionId, batchIds),
          ));
        const doneLabelsByPredictionId = new Map<string, Set<string>>();
        for (const row of existingHorizonRows) {
          if (!doneLabelsByPredictionId.has(row.predictionId)) doneLabelsByPredictionId.set(row.predictionId, new Set());
          doneLabelsByPredictionId.get(row.predictionId)!.add(row.horizonLabel);
        }

        for (const { k } of pendingKronos) {
          if (outOfTime()) { stats.bailedOnWallClock = true; break; }
          stats.rowsProcessed += 1;
          const idStr = String(k.id);
          const done = doneLabelsByPredictionId.get(idStr) ?? new Set<string>();
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
              stats.rowsWritten += 1;
            } catch (e) {
              console.error('[MultiHorizonOutcomeEvaluator] Failed to persist horizon outcome', e);
            }
          }
        }
      }
    }

    this.lastCycleStats = stats;
  }
}

export const multiHorizonOutcomeEvaluator = new MultiHorizonOutcomeEvaluator();
