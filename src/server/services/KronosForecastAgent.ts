/**
 * ==========================================================
 * Module: KronosForecastAgent
 *
 * Purpose:
 * Acts as the agentic wrapper for the Kronos Foundation Model, 
 * integrating it into the broader multi-agent trading ecosystem.
 *
 * Responsibilities:
 * - Listens for live market data updates.
 * - Triggers Kronos forecasting for various timeframes.
 * - Emits specific EventBus notifications (e.g., KRONOS_REVERSAL).
 * - Submits formalized trade ideas to the ChiefTraderAgent for consensus.
 *
 * Inputs:
 * - Real-time OHLCV market data via EVENTBUS.
 *
 * Outputs:
 * - Broadcasts TRADE_IDEA_GENERATED, KRONOS_HIGH_CONFIDENCE, etc.
 *
 * Assumptions:
 * - KronosEngine is initialized and available.
 * - ChiefTraderAgent processes the 'KronosEngine' agent weight.
 * ==========================================================
 */
import { eventBus } from '../core/EventBus';
import { kronosEngine } from '../engines/kronos/KronosEngine';
import { ForecastPrediction } from '../engines/forecasting/IForecastEngine';

export class KronosForecastAgent {
  
  /**
   * Initializes the agent and subscribes to market data events.
   */
  constructor() {
    eventBus.on('MARKET_DATA_UPDATED', async (data: any) => {
      // Whenever new market data comes in, attempt to generate a forecast if Kronos is ready
      if (kronosEngine.getStatus().isAvailable && data && data.symbol && data.candles) {
         try {
             // Example: predicting 5 periods ahead on the current timeframe
             const prediction = await kronosEngine.predict(data.symbol, 5, '1m', data.candles);
             this.broadcastForecast(prediction);
         } catch (e) {
             // Ignore transient unavailability or inference errors
         }
      }
    });
  }

  /**
   * Analyzes the generated forecast and publishes relevant system events.
   * If a clear BUY/SELL signal is present, forwards it to the Chief Trader.
   * 
   * @param prediction The generated prediction object from Kronos.
   */
  private broadcastForecast(prediction: ForecastPrediction) {
      if (prediction.prediction === 'BUY' || prediction.prediction === 'SELL') {
          // Broadcast high/low confidence flags for other agents (e.g. Risk Agent)
          if (prediction.confidence > 0.8) {
              eventBus.publish('KRONOS_HIGH_CONFIDENCE', prediction);
          } else if (prediction.confidence < 0.4) {
              eventBus.publish('KRONOS_LOW_CONFIDENCE', prediction);
          }
          
          // Broadcast specific market structure changes
          if (prediction.marketStructure?.includes('reversal')) {
              eventBus.publish('KRONOS_REVERSAL', prediction);
          }
          if (prediction.marketStructure?.includes('breakout')) {
              eventBus.publish('KRONOS_BREAKOUT', prediction);
          }

          // Inject into the Chief Trader consensus loop
          eventBus.publish('TRADE_IDEA_GENERATED', {
              traceId: `kronos-${Date.now()}`,
              symbol: prediction.symbol,
              side: prediction.prediction,
              confidence: prediction.confidence,
              reasoning: `Kronos predicts ${prediction.prediction} based on ${prediction.timeframe} timeframe. Expected move: ${prediction.expectedMove}.`,
              agent: 'KronosEngine'
          });
      }
  }
}

// Export singleton instance
export const kronosForecastAgent = new KronosForecastAgent();
