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
 *   service is reachable.
 * - Emits specific EventBus notifications (e.g., KRONOS_REVERSAL).
 * - Submits formalized trade ideas to the ChiefTraderAgent for consensus.
 *
 * Inputs:
 * - Real-time price ticks via EventBus's 'MARKET_DATA' event.
 *
 * Outputs:
 * - Broadcasts TRADE_IDEA_GENERATED, KRONOS_HIGH_CONFIDENCE, etc.
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

  private async onTick(data: { symbol?: string; price?: number }) {
    notePipelineAgentTick('KronosEngine');
    if (!isLiveIdeaGenerationEnabled()) {
      notePipelineAgentGated('KronosEngine');
      return;
    }
    if (!isPipelineAgentEnabled('KronosEngine')) {
      notePipelineAgentGated('KronosEngine');
      return;
    }
    if (!data?.symbol || typeof data.price !== 'number' || !Number.isFinite(data.price)) return;

    const history = this.priceHistory[data.symbol] || (this.priceHistory[data.symbol] = []);
    history.push(data.price);
    if (history.length > MAX_HISTORY) history.shift();

    if (history.length < MIN_HISTORY) return;
    if (!kronosEngine.getStatus().isAvailable) return;

    const last = this.lastPredictionAt[data.symbol] || 0;
    if (Date.now() - last < PREDICTION_COOLDOWN_MS) return;
    this.lastPredictionAt[data.symbol] = Date.now();

    try {
      const prediction = await kronosEngine.predict(data.symbol, HORIZON, TIMEFRAME, history.slice());
      this.broadcastForecast(prediction);
    } catch (e: any) {
      notePipelineAgentFailure('KronosEngine', e);
      // Local inference service unreachable/erroring - already logged inside KronosEngine.
      // Never let this take down the tick-handling path for other agents.
    }
  }

  /**
   * Analyzes the generated forecast and publishes relevant system events.
   * If a clear BUY/SELL signal is present, forwards it to the Chief Trader.
   */
  private broadcastForecast(prediction: ForecastPrediction) {
    if (prediction.prediction === 'BUY' || prediction.prediction === 'SELL') {
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
      notePipelineAgentSuccess('KronosEngine');
    }
  }
}

// Export singleton instance
export const kronosForecastAgent = new KronosForecastAgent();
