/**
 * ==========================================================
 * Module: KronosForecastAgent
 *
 * Purpose:
 * Acts as the agentic wrapper for the local Chronos time-series forecasting
 * model, integrating it into the broader multi-agent trading ecosystem.
 *
 * Responsibilities:
 * - Maintains a real rolling per-symbol price history from live market ticks.
 * - Triggers a forecast once enough history exists and the local inference
 *   service is reachable (research/UI path — independent of Autobot).
 * - Emits TRADE_IDEA_GENERATED only when live idea generation is enabled AND
 *   Chronos is healthy (fail-closed for ideas when /health is down).
 *
 * Inputs:
 * - Real-time price ticks via EventBus's 'MARKET_DATA' event.
 *
 * Outputs:
 * - Persisted forecasts (kronos_predictions + agent_predictions via KronosEngine).
 * - Optional TRADE_IDEA_GENERATED when Autobot/idea gate allows.
 * ==========================================================
 */
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';
import { isPipelineAgentEnabled } from '../core/pipelineAgentGate';
import { kronosEngine } from '../engines/kronos/KronosEngine';
import { ForecastPrediction } from '../engines/forecasting/IForecastEngine';
import { quantThresholds } from '../config/quantThresholds';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { notePipelineAgentFailure, notePipelineAgentGated, notePipelineAgentSuccess, notePipelineAgentTick } from '../core/pipelineAgentHealth';
import { generateTraceId } from '../core/traceId';
import { isKronosDissimilarityGateEnabled } from '../config/kronosDissimilarityGate';
import {
  computeInputFeatures, assessDissimilarity,
  getCachedKronosReferenceStats, isKronosReferenceStatsCacheStale, refreshKronosReferenceStats,
} from '../quant/KronosDissimilarityGate';

// Chronos needs a real window of history to say anything meaningful about the next few steps -
// this is a real minimum, not an arbitrary one: too short a context is indistinguishable from
// noise for any time-series model.
const MIN_HISTORY = quantThresholds.kronosMinHistory;
const MAX_HISTORY = quantThresholds.kronosMaxHistory;
const PREDICTION_COOLDOWN_MS = runtimeIntervals.kronosPredictionCooldownMs;
const HORIZON = quantThresholds.kronosHorizon;
const TIMEFRAME = quantThresholds.kronosTimeframe;

export class KronosForecastAgent {
  private priceHistory: Record<string, number[]> = {};
  private lastPredictionAt: Record<string, number> = {};
  private lastUnavailableTelemetryAt = 0;
  private listening = false;
  private readonly onMarketData = (data: any) => { void this.onTick(data); };

  start() {
    if (this.listening) return;
    eventBus.subscribe('MARKET_DATA', this.onMarketData);
    this.listening = true;
  }

  stop() {
    if (!this.listening) return;
    eventBus.unsubscribe('MARKET_DATA', this.onMarketData);
    this.listening = false;
  }

  /** Test / diagnostics: whether the MARKET_DATA listener is armed. */
  isListening(): boolean {
    return this.listening;
  }

  /**
   * Manual co-eval: one Chronos forecast if history + local service allow.
   * Never fabricates a BUY/SELL when Chronos is down.
   */
  async evaluateOnDemand(symbol: string): Promise<{ status: string }> {
    const sym = symbol.toUpperCase();
    if (!isPipelineAgentEnabled('KronosEngine')) return { status: 'gated' };
    notePipelineAgentTick('KronosEngine');

    let history = this.priceHistory[sym] || [];
    const { marketDataWorker } = await import('./MarketDataWorker');
    const live = marketDataWorker.getLatestPrice(sym);
    if (typeof live === 'number' && Number.isFinite(live) && live > 0) {
      history = [...history, live];
    }
    if (history.length < MIN_HISTORY) {
      try {
        const { historicalDataGateway } = await import('../engines/backtest/HistoricalDataGateway');
        const endMs = Date.now();
        const startMs = endMs - 90 * 24 * 60 * 60 * 1000;
        await historicalDataGateway.ensureBars(sym, '1Day', startMs, endMs);
        const bars = await historicalDataGateway.getBars(sym, '1Day', startMs, endMs);
        history = bars.map((b) => b.close).filter((c) => c > 0);
        if (typeof live === 'number' && live > 0) history.push(live);
      } catch {
        return { status: 'insufficient_history' };
      }
    }
    if (history.length < MIN_HISTORY) return { status: 'insufficient_history' };
    if (!kronosEngine.getStatus().isAvailable) {
      this.emitUnavailableTelemetry(sym, 'LOCAL_AI_SERVICE_URL /health not ready');
      return { status: 'chronos_unavailable' };
    }

    this.priceHistory[sym] = history.slice(-MAX_HISTORY);
    this.lastPredictionAt[sym] = 0;
    try {
      const inputCloses = this.priceHistory[sym].slice();
      const prediction = await kronosEngine.predict(sym, HORIZON, TIMEFRAME, inputCloses);
      if (!kronosEngine.getStatus().isAvailable) return { status: 'chronos_unavailable' };
      this.broadcastForecast(prediction, inputCloses);
      notePipelineAgentSuccess('KronosEngine');
      return { status: 'forecasted' };
    } catch (e: any) {
      notePipelineAgentFailure('KronosEngine', e);
      return { status: `error:${e?.message || e}` };
    }
  }

  private emitUnavailableTelemetry(symbol: string, detail: string) {
    const now = Date.now();
    if (now - this.lastUnavailableTelemetryAt < PREDICTION_COOLDOWN_MS) return;
    this.lastUnavailableTelemetryAt = now;
    eventBus.publish(EVENTS.KRONOS_UNAVAILABLE, {
      symbol,
      detail,
      agent: 'KronosEngine',
      side: 'HOLD',
      confidence: 0,
      timestamp: new Date().toISOString(),
    });
    console.warn(`[KronosForecastAgent] Chronos unavailable for ${symbol} — no TRADE_IDEA_GENERATED (${detail}).`);
  }

  private async onTick(data: { symbol?: string; price?: number }) {
    notePipelineAgentTick('KronosEngine');
    // Operator can disable Kronos from Mission Control; research + ideas both stop.
    if (!isPipelineAgentEnabled('KronosEngine')) {
      notePipelineAgentGated('KronosEngine');
      return;
    }
    if (!data?.symbol || typeof data.price !== 'number' || !Number.isFinite(data.price)) return;

    // Buffer ticks even when Autobot is off so Chronos can still produce UI/research forecasts.
    const history = this.priceHistory[data.symbol] || (this.priceHistory[data.symbol] = []);
    history.push(data.price);
    if (history.length > MAX_HISTORY) history.shift();

    if (history.length < MIN_HISTORY) return;
    if (!kronosEngine.getStatus().isAvailable) {
      this.emitUnavailableTelemetry(data.symbol, 'LOCAL_AI_SERVICE_URL /health not ready');
      return;
    }

    const last = this.lastPredictionAt[data.symbol] || 0;
    if (Date.now() - last < PREDICTION_COOLDOWN_MS) return;
    this.lastPredictionAt[data.symbol] = Date.now();

    try {
      const inputCloses = history.slice();
      const prediction = await kronosEngine.predict(data.symbol, HORIZON, TIMEFRAME, inputCloses);
      // Fail-closed for ideas: never emit BUY/SELL if availability flipped while the call was in flight.
      if (!kronosEngine.getStatus().isAvailable) {
        this.emitUnavailableTelemetry(data.symbol, 'Chronos became unavailable during forecast');
        return;
      }
      this.broadcastForecast(prediction, inputCloses);
      notePipelineAgentSuccess('KronosEngine');
    } catch (e: any) {
      notePipelineAgentFailure('KronosEngine', e);
      this.emitUnavailableTelemetry(data.symbol, e?.message || 'forecast call failed');
      // Local inference service unreachable/erroring - already logged inside KronosEngine.
      // Never fabricate confidence or emitTradeIdea on this path.
    }
  }

  /**
   * Analyzes the generated forecast and publishes relevant system events.
   * BUY/SELL trade ideas require live idea generation (Autobot + TRADING_ENABLED + session hold).
   * Forecasts are already persisted by KronosEngine.metrics regardless of Autobot.
   */
  private broadcastForecast(prediction: ForecastPrediction, inputCloses: number[]) {
    if (prediction.prediction !== 'BUY' && prediction.prediction !== 'SELL') {
      return;
    }

    if (prediction.confidence > 0.8) {
      eventBus.publish(EVENTS.KRONOS_HIGH_CONFIDENCE, prediction);
    } else if (prediction.confidence < 0.4) {
      eventBus.publish(EVENTS.KRONOS_LOW_CONFIDENCE, prediction);
    }

    if (prediction.marketStructure?.includes('reversal')) {
      eventBus.publish(EVENTS.KRONOS_REVERSAL, prediction);
    }
    if (prediction.marketStructure?.includes('breakout')) {
      eventBus.publish(EVENTS.KRONOS_BREAKOUT, prediction);
    }

    // Ideas stay Autobot/session-gated. Research persistence already happened in KronosEngine.
    if (!isLiveIdeaGenerationEnabled()) {
      notePipelineAgentGated('KronosEngine');
      return;
    }

    // Model-trust / dissimilarity gate (2026-09-04, off unless KRONOS_OOD_GATE_ENABLED='true'):
    // independent of prediction.confidence by construction (assessDissimilarity never receives
    // it) - a model saying 80%+ confidence does not override a NOVEL (out-of-distribution)
    // classification. Only the live IDEA is rejected here; the forecast itself was already
    // persisted above via KronosEngine.metrics, so research/observability value is never lost.
    if (isKronosDissimilarityGateEnabled()) {
      const features = computeInputFeatures(inputCloses);
      if (isKronosReferenceStatsCacheStale()) void refreshKronosReferenceStats();
      const assessment = features
        ? assessDissimilarity(features, getCachedKronosReferenceStats())
        : { status: 'INSUFFICIENT_REFERENCE_DATA' as const, maxAbsZ: null, perFeatureZ: null, referenceSampleSize: 0 };
      if (assessment.status === 'NOVEL') {
        eventBus.publish(EVENTS.KRONOS_OOD_REJECTED, {
          symbol: prediction.symbol,
          side: prediction.prediction,
          confidence: prediction.confidence,
          maxAbsZ: assessment.maxAbsZ,
          perFeatureZ: assessment.perFeatureZ,
          referenceSampleSize: assessment.referenceSampleSize,
          agent: 'KronosEngine',
          timestamp: new Date().toISOString(),
        });
        notePipelineAgentGated('KronosEngine');
        return;
      }
    }

    eventBus.emitTradeIdea({
      // Real bug found and fixed this pass: `kronos-${Date.now()}` collides across symbols at
      // 1ms resolution (plausible under a burst of ticks across several subscribed symbols),
      // silently merging two unrelated decisions into one trace for RiskEngine/OMS/fill
      // observability. generateTraceId(symbol) is the standard helper every other idea agent
      // uses, mixing in the symbol plus random bytes specifically to avoid this.
      traceId: generateTraceId(prediction.symbol),
      symbol: prediction.symbol,
      side: prediction.prediction,
      confidence: prediction.confidence,
      currentPrice: this.priceHistory[prediction.symbol]?.slice(-1)[0],
      reasoning: `Chronos forecasts ${prediction.prediction} (expected move ${prediction.expectedMove} over ${prediction.forecastHorizon} steps, support ${prediction.support}, resistance ${prediction.resistance}).`,
      agent: 'KronosEngine',
    });
  }
}

// Export singleton instance
export const kronosForecastAgent = new KronosForecastAgent();
