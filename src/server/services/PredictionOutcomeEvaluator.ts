/**
 * ==========================================================
 * Module: PredictionOutcomeEvaluator
 *
 * Purpose:
 * Phase 4 of TRANSACTION_OBSERVATORY_ARCHITECTURE.md. Answers "what actually happened" for a
 * prediction using real point-in-time OHLCV bars (via HistoricalDataGateway, the same real
 * Alpaca-backed source the backtest engine and RiskEngine's correlation gate already use) -
 * replacing ReflectionEngine's prior "nearest FILLED trade within 5 minutes" proxy, which
 * compared a prediction's outcome to whatever trade happened to be nearby rather than the real
 * price at a defined horizon after the prediction was made.
 *
 * Evaluates BOTH `agent_predictions` (Technical/News/Fundamental/Macro/consensus-debate ideas)
 * and `kronos_predictions` (Kronos's own forecasts) through the same real-bars mechanism,
 * writing to one shared `prediction_outcomes` table disambiguated by `sourceTable`.
 *
 * Never fabricates an outcome: a prediction whose symbol has no real bar history for the
 * evaluation window (most likely because ALPACA_API_KEY/SECRET aren't configured) is simply
 * left unevaluated - no row is written - rather than guessing.
 * ==========================================================
 */
import { db } from '../db';
import { agentPredictions, kronosPredictions, predictionOutcomes, newsPredictions } from '../db/schema';
import { and, eq, isNull, ne, notLike, or, asc, sql } from 'drizzle-orm';
import { historicalDataGateway } from '../engines/backtest/HistoricalDataGateway';
import { tradingSafety } from '../config/tradingSafety';
import { resolveEvaluationDueMs } from '../news/NewsPredictionEvaluation';
import { resolveEvaluationHorizonMs, secondaryGroupKey } from '../research/predictionIndependencePolicy';
import type { ExpectedHorizon } from '../news/NewsIntelligence';
import { TELEMETRY_PULSE_TRACE_PREFIX } from '../core/telemetryPulse';
import { evaluationHorizons } from '../config/evaluationHorizons';
import { evaluateTrendFollowingExit } from './TrendFollowingExitEvaluator';
import { createSingleFlightGuard, type SingleFlightGuard, type SingleFlightIntervalMetrics } from '../core/singleFlightInterval';

export const EVALUATION_HORIZON_MS = tradingSafety.evaluationHorizonMs;
// Kronos-specific horizon (M5, ARGUS_PREDICTIVE_EDGE_FORENSIC_AUDIT.md) - see tradingSafety.ts's
// own doc comment on kronosEvaluationHorizonMs for why this differs from EVALUATION_HORIZON_MS.
export const KRONOS_EVALUATION_HORIZON_MS = tradingSafety.kronosEvaluationHorizonMs;

function newsHorizonDurations() {
  return {
    intradayMs: tradingSafety.newsPredictionEvalIntradayMs,
    shortTermMs: tradingSafety.newsPredictionEvalShortTermMs,
    mediumTermMs: tradingSafety.newsPredictionEvalMediumTermMs,
    longerTermMs: tradingSafety.newsPredictionEvalLongerTermMs,
  };
}

export interface EvaluatedOutcome {
  predictionId: string;
  // 'transactions' is used by Phase 7's TrainingExampleBuilder to label a whole consensus
  // decision (not persisted to prediction_outcomes, which is prediction-level only) - reusing
  // this same real bars-based evaluation logic rather than a second mechanism. 'news_predictions'
  // (Phase F6) is News's own ACTIVE_OBSERVE-mode prediction ledger (src/server/news/) - it never
  // emits TRADE_IDEA_GENERATED, so it is never captured by ReflectionEngine's agent_predictions
  // listener; this evaluator reads it directly instead. 'consensus_debate_predictions'
  // (ConsensusDebate P0.5 forensic measurement, 2026-09-13) grades baseConsensusSide - "would the
  // candidate ConsensusDebate voted on have won or lost" - via ConsensusDebateOutcomeEvaluator.ts.
  sourceTable: 'agent_predictions' | 'kronos_predictions' | 'transactions' | 'news_predictions' | 'consensus_debate_predictions';
  symbol: string;
  actualPrice: number;
  actualReturn: number;
  actualDirection: 'UP' | 'DOWN' | 'FLAT';
  mfe: number | null;
  mae: number | null;
  outcome: 'WIN' | 'LOSS' | 'N_A';
  evaluatedAt: string;
}

/**
 * Real bars-based evaluation for one prediction. Returns null (never a fabricated result) if
 * fewer than 2 real bars exist across the evaluation window - typically because no Alpaca
 * credentials are configured, or the symbol has no real trading history in that window.
 */
export async function evaluatePrediction(
  predictionId: string,
  sourceTable: 'agent_predictions' | 'kronos_predictions' | 'transactions' | 'news_predictions' | 'consensus_debate_predictions',
  symbol: string,
  side: string,
  predictionTimeMs: number,
  // News predictions carry their own expectedHorizon (Phase F3), unlike the other prediction
  // types - so News evaluation uses a per-prediction window instead of the one fixed
  // EVALUATION_HORIZON_MS every other caller uses.
  horizonMs: number = EVALUATION_HORIZON_MS,
): Promise<EvaluatedOutcome | null> {
  const horizonEnd = predictionTimeMs + horizonMs;
  let bars;
  try {
    bars = await historicalDataGateway.getBars(symbol, '1Min', predictionTimeMs, horizonEnd);
    if (bars.length < 2) {
      await historicalDataGateway.ensureBars(symbol, '1Min', predictionTimeMs, horizonEnd);
      bars = await historicalDataGateway.getBars(symbol, '1Min', predictionTimeMs, horizonEnd);
    }
  } catch {
    return null; // no real data source available - never fabricate
  }
  if (bars.length < 2) return null;

  const entryPrice = bars[0].close;
  const finalPrice = bars[bars.length - 1].close;
  if (entryPrice <= 0) return null;

  const actualReturn = (finalPrice - entryPrice) / entryPrice;
  const actualDirection: 'UP' | 'DOWN' | 'FLAT' = finalPrice > entryPrice ? 'UP' : finalPrice < entryPrice ? 'DOWN' : 'FLAT';

  const isLong = side === 'BUY';
  const isDirectional = side === 'BUY' || side === 'SELL';

  // MFE/MAE in the direction of the prediction (flipped for SELL, so "favorable" is always
  // positive regardless of side) - the real running best/worst excursion across the window, not
  // just the endpoint.
  let mfe = -Infinity;
  let mae = Infinity;
  for (const bar of bars) {
    const ret = (bar.close - entryPrice) / entryPrice;
    const directional = isLong ? ret : -ret;
    if (directional > mfe) mfe = directional;
    if (directional < mae) mae = directional;
  }

  let outcome: 'WIN' | 'LOSS' | 'N_A' = 'N_A';
  if (isDirectional && actualDirection !== 'FLAT') {
    const correct = isLong ? finalPrice > entryPrice : finalPrice < entryPrice;
    outcome = correct ? 'WIN' : 'LOSS';
  }

  return {
    predictionId,
    sourceTable,
    symbol,
    actualPrice: finalPrice,
    actualReturn,
    actualDirection,
    mfe: isDirectional && mfe !== -Infinity ? mfe : null,
    mae: isDirectional && mae !== Infinity ? mae : null,
    outcome,
    evaluatedAt: new Date().toISOString(),
  };
}

export interface PredictionOutcomeEvaluatorCycleStats {
  rowsFetched: number;
  rowsProcessed: number;
  rowsWritten: number;
  batches: number;
  bailedOnWallClock: boolean;
  /** True backlog size (a COUNT(*) against the same pending condition, not just this cycle's
   *  bounded fetch window) - operator correctness audit (2026-09-14): "rowsRemaining actually
   *  reflects backlog rather than just the current query window." Summed across all three source
   *  tables (agent_predictions + kronos_predictions + news_predictions). */
  rowsRemaining: number;
}

const EMPTY_CYCLE_STATS: PredictionOutcomeEvaluatorCycleStats = {
  rowsFetched: 0, rowsProcessed: 0, rowsWritten: 0, batches: 0, bailedOnWallClock: false, rowsRemaining: 0,
};

export class PredictionOutcomeEvaluator {
  private intervalId: NodeJS.Timeout | null = null;
  // P1-A remediation (2026-09-14): the guard lives on evaluatePending() itself, not on the timer -
  // see singleFlightInterval.ts's own doc comment for why. This protects the timer-driven cycle
  // AND any future direct/manual caller (an ops "re-run now" route, a test) uniformly, rather than
  // only the specific call path start() happens to use today.
  private guard: SingleFlightGuard = createSingleFlightGuard((e) => console.error('[PredictionOutcomeEvaluator] Cycle failed', e));
  private lastCycleStats: PredictionOutcomeEvaluatorCycleStats = EMPTY_CYCLE_STATS;

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => { void this.evaluatePending(); }, tradingSafety.predictionOutcomeIntervalMs);
    void this.evaluatePending();
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** P1-A remediation observability (2026-09-14): overlap/coalescing + last-cycle row counts, for
   *  the same class of "is this evaluator actually bounded" question the forensic harness answers
   *  offline - exposed here so it can be checked live too (GET /api/v2/observability/metrics or a
   *  future dedicated route), not just measured after the fact. */
  getMetrics(): SingleFlightIntervalMetrics & { lastCycle: PredictionOutcomeEvaluatorCycleStats } {
    return { ...this.guard.getMetrics(), lastCycle: this.lastCycleStats };
  }

  /** Public entry point - single-flight guarded, safe to call concurrently from anywhere. */
  async evaluatePending(): Promise<void> {
    await this.guard.run(() => this.runCycle());
  }

  private async runCycle(): Promise<void> {
    const now = Date.now();
    const cycleStart = Date.now();
    const batchSize = tradingSafety.predictionOutcomeBatchSize;
    const maxWallClockMs = tradingSafety.predictionOutcomeMaxCycleWallClockMs;
    const stats: PredictionOutcomeEvaluatorCycleStats = { rowsFetched: 0, rowsProcessed: 0, rowsWritten: 0, batches: 0, bailedOnWallClock: false, rowsRemaining: 0 };
    const outOfTime = () => Date.now() - cycleStart > maxWallClockMs;

    // Bounded anti-join, oldest-first: a row stops being a candidate the moment it actually has a
    // prediction_outcomes row (P0.4-style unique index on (predictionId, sourceTable) already
    // backs this). Deliberately NOT a monotonic id/timestamp watermark - the exit-aware
    // walk-forward path below can legitimately leave a row "not yet evaluated" for a long
    // configured window, and a watermark that had already advanced past it would silently never
    // retry it. KronosEngine rows and telemetry-pulse rows are excluded here (not just skipped in
    // the loop below) because this evaluator NEVER writes an outcome for them - leaving them in the
    // anti-join would mean they permanently occupy batch slots on every future cycle instead of
    // freeing bounded capacity for rows that actually need evaluation.
    const agentPendingCondition = and(
      isNull(predictionOutcomes.id),
      ne(agentPredictions.agentName, 'KronosEngine'),
      // SQL three-valued logic: `traceId NOT LIKE 'x'` evaluates to NULL (excluded, not included)
      // when traceId itself is NULL - the common case, since most predictions carry no traceId.
      // Must explicitly allow the NULL case through, or every traceId-less row is silently
      // dropped from the anti-join - caught by this file's own test suite before this shipped.
      or(isNull(agentPredictions.traceId), notLike(agentPredictions.traceId, `${TELEMETRY_PULSE_TRACE_PREFIX}%`)),
    );
    const pendingAgent = await db
      .select({ p: agentPredictions })
      .from(agentPredictions)
      .leftJoin(predictionOutcomes, and(
        eq(predictionOutcomes.predictionId, agentPredictions.id),
        eq(predictionOutcomes.sourceTable, 'agent_predictions'),
      ))
      .where(agentPendingCondition)
      .orderBy(asc(agentPredictions.timestamp))
      .limit(batchSize);
    stats.rowsFetched += pendingAgent.length;
    stats.batches += 1;
    // Real backlog size, not just this cycle's bounded window - operator correctness audit
    // requirement. Same WHERE/JOIN, no LIMIT; the index added alongside this fix
    // (idx_agent_predictions_timestamp) keeps this cheap even as the table grows.
    const [{ count: agentRemainingCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(agentPredictions)
      .leftJoin(predictionOutcomes, and(
        eq(predictionOutcomes.predictionId, agentPredictions.id),
        eq(predictionOutcomes.sourceTable, 'agent_predictions'),
      ))
      .where(agentPendingCondition);
    stats.rowsRemaining += agentRemainingCount;

    for (const { p } of pendingAgent) {
      if (outOfTime()) { stats.bailedOnWallClock = true; break; }
      stats.rowsProcessed += 1;
      const predTime = new Date(p.timestamp).getTime();
      // Evaluation-horizon-mismatch remediation (2026-09-04): resolved per agent/strategy instead
      // of the previous blind universal EVALUATION_HORIZON_MS - see predictionIndependencePolicy.ts's
      // resolveEvaluationHorizonMs() and config/evaluationHorizons.json for the full rationale.
      const horizonMs = resolveEvaluationHorizonMs(p.agentName, p.reasoning);
      if (now - predTime < horizonMs) continue;

      // Exit-aware evaluation follow-up (2026-09-04): strategies with no real fixed target (e.g.
      // TREND_FOLLOWING) are graded by a real walk-forward exit simulation instead of a
      // fixed-horizon snapshot - see config/evaluationHorizons.json's exitAwareStrategyIds comment
      // and TrendFollowingExitEvaluator.ts for the full rationale. Membership is config-driven, not
      // a hardcoded strategy-id literal, per this codebase's own standing rule.
      const rawStrategyKey = p.agentName === 'QuantEngine' ? secondaryGroupKey('QuantEngine', p.reasoning) : null;
      const strategyId = rawStrategyKey ? rawStrategyKey.replace(/__COLD_START_BOOTSTRAP$/, '') : null;
      if (strategyId && (p.prediction === 'BUY' || p.prediction === 'SELL')
        && evaluationHorizons.exitAwareStrategyIds.includes(strategyId)) {
        const exitResult = await evaluateTrendFollowingExit(
          p.symbol, p.prediction, predTime, evaluationHorizons.exitAwareMaxWalkForwardMs,
        );
        if (!exitResult) continue; // insufficient real bar data - never fabricate, retry later
        const walkForwardElapsed = now - predTime >= evaluationHorizons.exitAwareMaxWalkForwardMs;
        // A real exit was found (WIN/LOSS/N_A-flat) -> persist now. Still open -> only persist once
        // the full walk-forward window has elapsed (an honest, final "inconclusive" record), never
        // sooner - retried next cycle otherwise so a later real exit is not missed.
        if (exitResult.outcome === 'STILL_OPEN' && !walkForwardElapsed) continue;
        const actualDirection: 'UP' | 'DOWN' | 'FLAT' = exitResult.finalPrice > exitResult.entryPrice
          ? 'UP' : exitResult.finalPrice < exitResult.entryPrice ? 'DOWN' : 'FLAT';
        const mapped: EvaluatedOutcome = {
          predictionId: p.id,
          sourceTable: 'agent_predictions',
          symbol: p.symbol,
          actualPrice: exitResult.finalPrice,
          actualReturn: exitResult.actualReturn ?? 0,
          actualDirection,
          mfe: null, // not modeled by the exit-aware walk-forward - honestly omitted, not fabricated
          mae: null,
          outcome: exitResult.outcome === 'STILL_OPEN' ? 'N_A' : exitResult.outcome,
          evaluatedAt: new Date().toISOString(),
        };
        try {
          await db.insert(predictionOutcomes).values(mapped).onConflictDoNothing();
          stats.rowsWritten += 1;
        } catch (e) {
          console.error('[PredictionOutcomeEvaluator] Failed to persist exit-aware outcome', e);
        }
        continue;
      }

      const result = await evaluatePrediction(p.id, 'agent_predictions', p.symbol, p.prediction, predTime, horizonMs);
      if (result) {
        try {
          await db.insert(predictionOutcomes).values(result).onConflictDoNothing();
          stats.rowsWritten += 1;
        } catch (e) {
          console.error('[PredictionOutcomeEvaluator] Failed to persist outcome', e);
        }
      }
    }

    // kronos_predictions: same bounded anti-join pattern - no always-skipped category here (unlike
    // the agent_predictions loop above), so no extra exclusion filters are needed.
    if (!outOfTime()) {
      const kronosJoinCondition = and(
        eq(predictionOutcomes.predictionId, kronosPredictions.id),
        eq(predictionOutcomes.sourceTable, 'kronos_predictions'),
      );
      const pendingKronos = await db
        .select({ k: kronosPredictions })
        .from(kronosPredictions)
        .leftJoin(predictionOutcomes, kronosJoinCondition)
        .where(isNull(predictionOutcomes.id))
        .orderBy(asc(kronosPredictions.timestamp))
        .limit(batchSize);
      stats.rowsFetched += pendingKronos.length;
      stats.batches += 1;
      const [{ count: kronosRemainingCount }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(kronosPredictions)
        .leftJoin(predictionOutcomes, kronosJoinCondition)
        .where(isNull(predictionOutcomes.id));
      stats.rowsRemaining += kronosRemainingCount;

      for (const { k } of pendingKronos) {
        if (outOfTime()) { stats.bailedOnWallClock = true; break; }
        stats.rowsProcessed += 1;
        const idStr = String(k.id);
        const predTime = new Date(k.timestamp).getTime();
        // Kronos's own forecast horizon is tick-based, not wall-clock - grade it over a shorter,
        // deliberate window instead of the generic 60-minute EVALUATION_HORIZON_MS (M5).
        if (now - predTime < KRONOS_EVALUATION_HORIZON_MS) continue;

        const result = await evaluatePrediction(idStr, 'kronos_predictions', k.symbol, k.prediction, predTime, KRONOS_EVALUATION_HORIZON_MS);
        if (result) {
          try {
            await db.insert(predictionOutcomes).values(result).onConflictDoNothing();
            stats.rowsWritten += 1;
          } catch (e) {
            console.error('[PredictionOutcomeEvaluator] Failed to persist outcome', e);
          }
        }
      }
    }

    // Phase F6: News's own ACTIVE_OBSERVE-mode predictions (never TRADE_IDEA_GENERATED, so never
    // seen by ReflectionEngine's agent_predictions listener). Direction is BULLISH/BEARISH, not
    // BUY/SELL - mapped here so evaluatePrediction's existing BUY/SELL contract stays untouched
    // for its other two callers. Same bounded anti-join pattern; no always-skipped category here.
    if (!outOfTime()) {
      const newsJoinCondition = and(
        eq(predictionOutcomes.predictionId, newsPredictions.id),
        eq(predictionOutcomes.sourceTable, 'news_predictions'),
      );
      const pendingNews = await db
        .select({ n: newsPredictions })
        .from(newsPredictions)
        .leftJoin(predictionOutcomes, newsJoinCondition)
        .where(isNull(predictionOutcomes.id))
        .orderBy(asc(newsPredictions.createdAt))
        .limit(batchSize);
      stats.rowsFetched += pendingNews.length;
      stats.batches += 1;
      const [{ count: newsRemainingCount }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(newsPredictions)
        .leftJoin(predictionOutcomes, newsJoinCondition)
        .where(isNull(predictionOutcomes.id));
      stats.rowsRemaining += newsRemainingCount;

      for (const { n } of pendingNews) {
        if (outOfTime()) { stats.bailedOnWallClock = true; break; }
        stats.rowsProcessed += 1;
        const predTime = new Date(n.createdAt).getTime();
        const horizonMs = resolveEvaluationDueMs(n.expectedHorizon as ExpectedHorizon, newsHorizonDurations());
        if (now - predTime < horizonMs) continue;

        const side = n.direction === 'BULLISH' ? 'BUY' : n.direction === 'BEARISH' ? 'SELL' : 'HOLD';
        const result = await evaluatePrediction(n.id, 'news_predictions', n.symbol, side, predTime, horizonMs);
        if (result) {
          try {
            await db.insert(predictionOutcomes).values(result).onConflictDoNothing();
            stats.rowsWritten += 1;
          } catch (e) {
            console.error('[PredictionOutcomeEvaluator] Failed to persist outcome', e);
          }
        }
      }
    }

    this.lastCycleStats = stats;
  }
}

export const predictionOutcomeEvaluator = new PredictionOutcomeEvaluator();
