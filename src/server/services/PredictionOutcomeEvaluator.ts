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
import type { ExpectedHorizon } from '../news/NewsIntelligence';

export const EVALUATION_HORIZON_MS = tradingSafety.evaluationHorizonMs;

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
  if (isDirectional) {
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
      const key = `agent_predictions:${p.id}`;
      if (evaluatedKeys.has(key)) continue;
      const predTime = new Date(p.timestamp).getTime();
      if (now - predTime < EVALUATION_HORIZON_MS) continue;

      const result = await evaluatePrediction(p.id, 'agent_predictions', p.symbol, p.prediction, predTime);
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
      if (now - predTime < EVALUATION_HORIZON_MS) continue;

      const result = await evaluatePrediction(idStr, 'kronos_predictions', k.symbol, k.prediction, predTime);
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
