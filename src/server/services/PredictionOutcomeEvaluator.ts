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
import { historicalDataGateway } from '../engines/backtest/HistoricalDataGateway';
import { tradingSafety } from '../config/tradingSafety';
import { resolveEvaluationDueMs } from '../news/NewsPredictionEvaluation';
import { resolveEvaluationHorizonMs, secondaryGroupKey } from '../research/predictionIndependencePolicy';
import type { ExpectedHorizon } from '../news/NewsIntelligence';
import { TELEMETRY_PULSE_TRACE_PREFIX } from '../core/telemetryPulse';
import { evaluationHorizons } from '../config/evaluationHorizons';
import { evaluateTrendFollowingExit } from './TrendFollowingExitEvaluator';

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
  // listener; this evaluator reads it directly instead.
  sourceTable: 'agent_predictions' | 'kronos_predictions' | 'transactions' | 'news_predictions';
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
  sourceTable: 'agent_predictions' | 'kronos_predictions' | 'transactions' | 'news_predictions',
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

export class PredictionOutcomeEvaluator {
  private intervalId: NodeJS.Timeout | null = null;

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.evaluatePending().catch(e => console.error('[PredictionOutcomeEvaluator] Cycle failed', e)), tradingSafety.predictionOutcomeIntervalMs);
    this.evaluatePending().catch(e => console.error('[PredictionOutcomeEvaluator] Initial cycle failed', e));
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async evaluatePending() {
    const now = Date.now();
    const existing = await db.select().from(predictionOutcomes).all();
    const evaluatedKeys = new Set(existing.map(o => `${o.sourceTable}:${o.predictionId}`));

    const predictions = await db.select().from(agentPredictions).all();
    for (const p of predictions) {
      // KronosEngine's own forecasts are already evaluated once, cleanly, from kronos_predictions
      // below - this table also carries a KronosMetrics dual-write (kept for KronosDashboardData's
      // trajectory chart) and, for ideas that clear the bar, a second ReflectionEngine-authored row.
      // Evaluating those too would grade the same underlying forecast 2-3x (ARGUS_PREDICTIVE_EDGE_
      // FORENSIC_AUDIT.md finding M1) - skip them here rather than fix it downstream in every
      // consumer.
      if (p.agentName === 'KronosEngine') continue;
      // Real defect fixed (2026-08-26 self-improvement loop audit): never grade a Digital Twin
      // telemetry-pulse row (UI demo animation) against real market data - see
      // ReflectionEngine.ts's identical fix for the write-side of this same gap.
      if (p.traceId && p.traceId.startsWith(TELEMETRY_PULSE_TRACE_PREFIX)) continue;
      const key = `agent_predictions:${p.id}`;
      if (evaluatedKeys.has(key)) continue;
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
        } catch (e) {
          console.error('[PredictionOutcomeEvaluator] Failed to persist exit-aware outcome', e);
        }
        continue;
      }

      const result = await evaluatePrediction(p.id, 'agent_predictions', p.symbol, p.prediction, predTime, horizonMs);
      if (result) {
        try {
          await db.insert(predictionOutcomes).values(result).onConflictDoNothing();
        } catch (e) {
          console.error('[PredictionOutcomeEvaluator] Failed to persist outcome', e);
        }
      }
    }

    const kronosRows = await db.select().from(kronosPredictions).all();
    for (const k of kronosRows) {
      const idStr = String(k.id);
      const key = `kronos_predictions:${idStr}`;
      if (evaluatedKeys.has(key)) continue;
      const predTime = new Date(k.timestamp).getTime();
      // Kronos's own forecast horizon is tick-based, not wall-clock - grade it over a shorter,
      // deliberate window instead of the generic 60-minute EVALUATION_HORIZON_MS (M5).
      if (now - predTime < KRONOS_EVALUATION_HORIZON_MS) continue;

      const result = await evaluatePrediction(idStr, 'kronos_predictions', k.symbol, k.prediction, predTime, KRONOS_EVALUATION_HORIZON_MS);
      if (result) {
        try {
          await db.insert(predictionOutcomes).values(result).onConflictDoNothing();
        } catch (e) {
          console.error('[PredictionOutcomeEvaluator] Failed to persist outcome', e);
        }
      }
    }

    // Phase F6: News's own ACTIVE_OBSERVE-mode predictions (never TRADE_IDEA_GENERATED, so never
    // seen by ReflectionEngine's agent_predictions listener). Direction is BULLISH/BEARISH, not
    // BUY/SELL - mapped here so evaluatePrediction's existing BUY/SELL contract stays untouched
    // for its other two callers.
    const newsRows = await db.select().from(newsPredictions).all();
    for (const n of newsRows) {
      const key = `news_predictions:${n.id}`;
      if (evaluatedKeys.has(key)) continue;
      const predTime = new Date(n.createdAt).getTime();
      const horizonMs = resolveEvaluationDueMs(n.expectedHorizon as ExpectedHorizon, newsHorizonDurations());
      if (now - predTime < horizonMs) continue;

      const side = n.direction === 'BULLISH' ? 'BUY' : n.direction === 'BEARISH' ? 'SELL' : 'HOLD';
      const result = await evaluatePrediction(n.id, 'news_predictions', n.symbol, side, predTime, horizonMs);
      if (result) {
        try {
          await db.insert(predictionOutcomes).values(result).onConflictDoNothing();
        } catch (e) {
          console.error('[PredictionOutcomeEvaluator] Failed to persist outcome', e);
        }
      }
    }
  }
}

export const predictionOutcomeEvaluator = new PredictionOutcomeEvaluator();
