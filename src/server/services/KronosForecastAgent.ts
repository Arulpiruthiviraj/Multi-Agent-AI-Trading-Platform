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
import { kronosEngine } from '../engines/kronos/KronosEngine';
import { ForecastPrediction } from '../engines/forecasting/IForecastEngine';

// Chronos needs a real window of history to say anything meaningful about the next few steps -
// this is a real minimum, not an arbitrary one: too short a context is indistinguishable from
// noise for any time-series model.
const MIN_HISTORY = 30;
const MAX_HISTORY = 200;
// The local inference service call has real latency (a few hundred ms on CPU) - this cooldown
// keeps KronosForecastAgent from calling it on every single tick per symbol.
const PREDICTION_COOLDOWN_MS = 60_000;
const HORIZON = 5;
const TIMEFRAME = 'tick';

export class KronosForecastAgent {
  private priceHistory: Record<string, number[]> = {};
  private lastPredictionAt: Record<string, number> = {};

  constructor() {
    eventBus.on('MARKET_DATA', (data: any) => this.onTick(data));
  }

  private async onTick(data: { symbol?: string; price?: number }) {
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
        eventBus.publish('KRONOS_HIGH_CONFIDENCE', prediction);
      } else if (prediction.confidence < 0.4) {
        eventBus.publish('KRONOS_LOW_CONFIDENCE', prediction);
      }

      if (prediction.marketStructure?.includes('reversal')) {
        eventBus.publish('KRONOS_REVERSAL', prediction);
      }
      if (prediction.marketStructure?.includes('breakout')) {
        eventBus.publish('KRONOS_BREAKOUT', prediction);
      }

      eventBus.publish('TRADE_IDEA_GENERATED', {
        traceId: `kronos-${Date.now()}`,
        symbol: prediction.symbol,
        side: prediction.prediction,
        confidence: prediction.confidence,
        reasoning: `Chronos forecasts ${prediction.prediction} (expected move ${prediction.expectedMove} over ${prediction.forecastHorizon} steps, support ${prediction.support}, resistance ${prediction.resistance}).`,
        agent: 'KronosEngine',
      });
    }
  }
}

// Export singleton instance
export const kronosForecastAgent = new KronosForecastAgent();
