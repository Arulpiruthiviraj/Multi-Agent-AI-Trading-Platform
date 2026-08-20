import { db } from '../../db';
import * as schema from '../../db/schema';
import { ForecastPrediction } from '../forecasting/IForecastEngine';
import crypto from 'crypto';

export class KronosMetrics {
  
  public async recordPrediction(prediction: ForecastPrediction, inputCandles: any[], latencyMs?: number | null) {
    try {
      const trajectory = (prediction.predictedOHLC || [])
        .map((c: any) => (typeof c === 'number' ? c : c?.close))
        .filter((v: unknown): v is number => typeof v === 'number' && Number.isFinite(v));

      await db.insert(schema.kronosPredictions).values({
        symbol: prediction.symbol,
        timeframe: prediction.timeframe,
        prediction: prediction.prediction,
        confidence: prediction.confidence,
        forecastHorizon: prediction.forecastHorizon,
        expectedMove: prediction.expectedMove,
        volatility: prediction.volatility,
        support: prediction.support,
        resistance: prediction.resistance,
        model: prediction.model,
        predictedOhlc: JSON.stringify(prediction.predictedOHLC || []),
        marketStructure: prediction.marketStructure || 'Unknown',
        momentum: prediction.momentum || 'Unknown',
        timestamp: prediction.timestamp || new Date().toISOString(),
      });

      // Dual-write into agent_predictions so ReflectionEngine / prediction_outcomes / dashboard
      // metrics can join on the same agent ledger as Technical/News/etc. Trajectory lives in
      // reasoning as JSON (agent_predictions has no OHLC column).
      const lastInput = Array.isArray(inputCandles) && inputCandles.length > 0
        ? (typeof inputCandles[inputCandles.length - 1] === 'number'
          ? inputCandles[inputCandles.length - 1]
          : inputCandles[inputCandles.length - 1]?.close ?? inputCandles[inputCandles.length - 1]?.price)
        : null;
      await db.insert(schema.agentPredictions).values({
        id: crypto.randomUUID(),
        agentName: 'KronosEngine',
        symbol: prediction.symbol,
        prediction: prediction.prediction,
        confidence: prediction.confidence,
        reasoning: JSON.stringify({
          source: 'Chronos',
          model: prediction.model,
          timeframe: prediction.timeframe,
          forecastHorizon: prediction.forecastHorizon,
          expectedMove: prediction.expectedMove,
          volatility: prediction.volatility,
          support: prediction.support,
          resistance: prediction.resistance,
          lastPrice: typeof lastInput === 'number' && Number.isFinite(lastInput) ? lastInput : null,
          priceTrajectory: trajectory,
        }),
        timestamp: prediction.timestamp || new Date().toISOString(),
        latencyMs: typeof latencyMs === 'number' && Number.isFinite(latencyMs) ? latencyMs : null,
      });
    } catch (e) {
      console.error('[KronosMetrics] Error recording prediction:', e);
    }
  }

  public async evaluateTrade(tradeId: string, actualResult: any) {
     // Reflection Engine uses this to learn from Kronos accuracy vs Actual
  }
}
