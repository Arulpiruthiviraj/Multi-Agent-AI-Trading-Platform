/**
 * ==========================================================
 * Module:
 * MarketRegimeAgent.ts
 *
 * Purpose:
 * Core implementation and logic for the MarketRegimeAgent.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for MarketRegimeAgent
 * - Interface with backend APIs and EventBus
 * - Render UI components (if React)
 *
 * Inputs:
 * - Module dependencies and injected props
 *
 * Outputs:
 * - Formatted data or React Elements
 *
 * Emits:
 * - Relevant system events
 *
 * Dependencies:
 * - Standard Argus architecture layers
 *
 * Called By:
 * - Argus Routing / Parent Components
 *
 * Never:
 * - Mutate global state directly without EventBus
 * - Call AI providers directly (Must use AIRouter)
 *
 * ==========================================================
 */

import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { AIRouter } from '../ai/AIRouter';
import { tradingSafety } from '../config/tradingSafety';
import { createSingleFlightGuard, type SingleFlightGuard } from '../core/singleFlightInterval';

export class MarketRegimeAgent {
  private currentRegime: string = "UNKNOWN";
  /** DEF-3 fix: constructor timer handle was previously discarded - no stop() existed and the
   *  module singleton started ticking at import time (leaking into tests). */
  private intervalId: NodeJS.Timeout | null = null;
  /** DEF-3 fix: single-flight guard on detectRegime() - the async cycle (a real AI call when
   *  GEMINI_API_KEY is set) can exceed the 5-minute interval; without coalescing, overlapping
   *  invocations issue duplicate AI calls per cycle. Uses the shared
   *  createSingleFlightGuard primitive (src/server/core/singleFlightInterval.ts). */
  private readonly regimeGuard: SingleFlightGuard = createSingleFlightGuard(
    (e) => console.error('[MarketRegime] cycle failed', e),
  );

  constructor() {
    this.intervalId = setInterval(() => void this.detectRegime(), tradingSafety.marketRegimeIntervalMs);
    void this.detectRegime();
  }

  /** Stops the periodic regime-detection timer. Wired into SystemBootstrap.stop() (called by the
   *  graceful-shutdown drain before sqliteDb.close()) and available to tests. */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async detectRegime(): Promise<void> {
    await this.regimeGuard.run(() => this.detectRegimeImpl());
  }

  private async detectRegimeImpl(): Promise<void> {
    try {
      if (!process.env.GEMINI_API_KEY) {
        this.currentRegime = "SIMULATED_BULL_MARKET";
        eventBus.emit(EVENTS.MARKET_REGIME_DETECTED, { regime: this.currentRegime, timestamp: new Date().toISOString() });
        return;
      }
      
      const prompt = `Analyze the current macroeconomic and technical context of the US equity market based on general knowledge up to today. 
Identify the current market regime from these options: 
- BULL_MARKET
- BEAR_MARKET
- SIDEWAYS_CHOPPY
- HIGH_VOLATILITY
- LOW_VOLATILITY
- RISK_ON
- RISK_OFF

Respond ONLY with a JSON object in this format:
{
  "regime": "BULL_MARKET",
  "confidence": 0.85,
  "reasoning": "Brief explanation."
}`;

      const res = await AIRouter.getInstance().routeTask('MarketRegimeAgent', prompt, Math.random().toString(36).substring(7));
          const response = { text: res.content };

      const text = response.text || "{}";
      const cleanedText = text.replace(/```json/g, "").replace(/```/g, "").trim();
      const result = JSON.parse(cleanedText);

      this.currentRegime = result.regime || "UNKNOWN";
      
      console.log(`[MarketRegime] Detected: ${this.currentRegime} (Conf: ${result.confidence}) - ${result.reasoning}`);
      
      eventBus.emit(EVENTS.MARKET_REGIME_DETECTED, { 
        regime: this.currentRegime, 
        confidence: result.confidence,
        reasoning: result.reasoning,
        timestamp: new Date().toISOString() 
      });

    } catch (e) {
      console.log(`[MarketRegime] Failed to detect regime: ${e}`);
    }
  }

  getCurrentRegime() {
    return this.currentRegime;
  }
}

export const marketRegimeAgent = new MarketRegimeAgent();
