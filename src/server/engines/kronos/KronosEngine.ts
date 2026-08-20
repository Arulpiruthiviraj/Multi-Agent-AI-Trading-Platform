/**
 * ==========================================================
 * Module: KronosEngine
 *
 * Purpose:
 * Core integration layer for the open-source Kronos Foundation Model.
 * This class exposes a unified forecasting interface (IForecastEngine) 
 * for generating time-series predictions from candlestick data.
 *
 * Responsibilities:
 * - Manages the lifecycle of the Kronos model (initialization/health).
 * - Orchestrates caching to prevent redundant inferences.
 * - Handles persistence of predictions to SQLite for reflection tracking.
 * - Broadcasts core inference lifecycle events.
 *
 * Dependencies:
 * - KronosModelManager
 * - KronosInference
 * - KronosPredictionCache
 * - KronosMetrics
 * ==========================================================
 */
import { KronosModelManager } from './KronosModelManager';
import { KronosInference } from './KronosInference';
import { KronosTokenizer } from './KronosTokenizer';
import { KronosPredictionCache } from './KronosPredictionCache';
import { KronosMetrics } from './KronosMetrics';
import { IForecastEngine, ForecastPrediction } from '../forecasting/IForecastEngine';
import { eventBus } from '../../core/EventBus';
import { quantThresholds } from '../../config/quantThresholds';
import { classifyKronosForecastFailure } from './kronosFailureKind';

export class KronosEngine implements IForecastEngine {
  public name: string = 'Kronos';
  public manager: KronosModelManager;
  public inference: KronosInference;
  public tokenizer: KronosTokenizer;
  public cache: KronosPredictionCache;
  public metrics: KronosMetrics;

  constructor() {
    this.manager = new KronosModelManager();
    this.inference = new KronosInference();
    this.tokenizer = new KronosTokenizer();
    this.cache = new KronosPredictionCache();
    this.metrics = new KronosMetrics();
  }

  /**
   * Initializes the underlying prediction model and related caches.
   */
  public async initialize(): Promise<void> {
    await this.manager.initialize();
  }

  /**
   * Performs a single-symbol time-series forecast.
   * 
   * @param symbol The ticker to predict (e.g., 'AAPL').
   * @param horizon Number of candles to forecast ahead.
   * @param timeframe The resolution of the candles (e.g., '1m', '1h').
   * @param ohlcvData The historical candle array.
   * @returns A ForecastPrediction object detailing expected moves and confidence.
   */
  public async predict(symbol: string, horizon: number, timeframe: string, ohlcvData: any[]): Promise<ForecastPrediction> {
    eventBus.publish('KRONOS_FORECAST_STARTED', { symbol, timeframe, horizon });
    if (!this.manager.isReady()) {
      throw new Error('Kronos inference service is not responding (LOCAL_AI_SERVICE_URL). Kronos is optional; other agents continue. Start it with npm run dev or npm run ai:serve');
    }

    try {
      // Execute inference via Python bridge or API
      const prediction = await this.inference.predict(symbol, horizon, timeframe, ohlcvData);
      const latencyMs = (prediction as any).latencyMs;
      if (typeof latencyMs === 'number') {
        this.manager.recordInferenceLatency(latencyMs);
      }
      
      // Cache the result for subsequent rapid lookups
      this.cache.set(symbol, timeframe, prediction);
      
      // Record to SQLite for Reflection Agent's performance analysis
      await this.metrics.recordPrediction(prediction, ohlcvData, latencyMs);
      
      eventBus.publish('KRONOS_FORECAST_COMPLETED', { symbol, timeframe, prediction });
      return prediction;
    } catch (e: any) {
      console.warn(`[KronosEngine] Prediction failed for ${symbol}: ${e.message}`);
      // CPU multi-symbol fan-out often times out one ticker while Chronos /health is still ok.
      // Fail-closed for THIS forecast only; do not latch global KRONOS_UNAVAILABLE forever.
      if (classifyKronosForecastFailure(e) === 'hard') {
        this.manager.markUnavailable(e?.message || 'prediction failed');
      } else {
        console.warn(`[KronosEngine] Transient forecast failure for ${symbol} — keeping Chronos available for other symbols.`);
      }
      throw e;
    }
  }

  /**
   * Performs batched forecasting across multiple assets simultaneously (GPU optimization).
   */
  public async batchPredict(symbols: string[], horizon: number, timeframe: string, dataMap: Record<string, any[]>): Promise<ForecastPrediction[]> {
    if (!this.manager.isReady()) {
      throw new Error('Kronos inference service is not responding (LOCAL_AI_SERVICE_URL). Kronos is optional; other agents continue. Start it with npm run dev or npm run ai:serve');
    }
    
    try {
      const predictions = await this.inference.batchPredict(symbols, horizon, timeframe, dataMap);
      for (const p of predictions) {
        this.cache.set(p.symbol, p.timeframe, p);
        await this.metrics.recordPrediction(p, dataMap[p.symbol]);
      }
      eventBus.publish('KRONOS_BATCH_COMPLETED', { symbols, timeframe });
      return predictions;
    } catch (e: any) {
       console.warn(`[KronosEngine] Batch prediction failed: ${e.message}`);
       if (classifyKronosForecastFailure(e) === 'hard') {
         this.manager.markUnavailable(e?.message || 'batch prediction failed');
       } else {
         console.warn('[KronosEngine] Transient batch forecast failure — keeping Chronos available.');
       }
       throw e;
    }
  }

  /**
   * Returns the current health, memory usage, and initialization status of the Kronos model.
   */
  public getStatus() {
    const base = this.manager.getStatusReport();
    return {
      ...base,
      forecastHorizon: quantThresholds.kronosHorizon,
      timeframe: quantThresholds.kronosTimeframe,
      confidenceThreshold: quantThresholds.kronosNeutralBandPct,
      multiAssetBatchMode: false,
    };
  }

  public async getStatusFresh() {
    const base = await this.manager.getStatusReportFresh();
    return {
      ...base,
      forecastHorizon: quantThresholds.kronosHorizon,
      timeframe: quantThresholds.kronosTimeframe,
      confidenceThreshold: quantThresholds.kronosNeutralBandPct,
      multiAssetBatchMode: false,
    };
  }
}

// Export singleton instance
export const kronosEngine = new KronosEngine();

// Auto-init is for the real Node process. Vitest workers that import SystemBootstrap/v2System
// must not open Chronos sockets — a half-open local_ai_service.py connection caused
// GET /api/v2/quant/strategies to fail with read ECONNRESET (~19s) while Chronos was "up".
if (process.env.VITEST !== 'true') {
  setTimeout(() => {
    kronosEngine.initialize().catch(console.error);
  }, 3000);
}
