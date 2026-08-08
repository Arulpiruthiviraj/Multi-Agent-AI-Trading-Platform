/**
 * ==========================================================
 * Module: MacroAgent.ts
 *
 * Purpose:
 * Evaluates real macro data if available.
 * ==========================================================
 */
import { eventBus } from '../core/EventBus';
import { AIRouter } from '../ai/AIRouter';
import crypto from 'crypto';

export class MacroEconomyAgent {
  private intervalId: NodeJS.Timeout | null = null;
  private watchedSymbols = ['NVDA', 'AAPL', 'TSLA'];

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.analyzeMacro(), 75000);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
  
  private async fetchMacro() {
     // Production app should integrate FRED, AlphaVantage Economic indicators
     return {
        inflation: "UNKNOWN",
        fedFundsRate: "UNKNOWN",
        unemployment: "UNKNOWN"
     };
  }

  private async analyzeMacro() {
    const symbol = this.watchedSymbols[Math.floor(Date.now() / 75000) % this.watchedSymbols.length];
    const traceId = crypto.randomUUID();
    
    try {
       const data = await this.fetchMacro();
       if (data.inflation === "UNKNOWN") {
          eventBus.emitTradeIdea({
             traceId, 
             symbol, 
             side: "HOLD", 
             confidence: 0, 
             reasoning: "DATA_UNAVAILABLE: Macro data providers not configured.", 
             agent: "MacroAgent"
          });
          return;
       }

       if (process.env.GEMINI_API_KEY) {
          const res = await AIRouter.getInstance().routeTask('MacroAgent', `Analyze these macroeconomic indicators for their impact on ${symbol}: CPI ${data.inflation}%, Fed Funds Rate ${data.fedFundsRate}%, Unemployment ${data.unemployment}%. Return strict JSON: { summary, recommendation, confidence, supportingEvidence, risks, reasoning }`, traceId);
          const response = { text: res.content };
          
          if (response.text) {
             const analysis = JSON.parse(response.text);
             if (analysis.recommendation !== "HOLD") {
                eventBus.emitTradeIdea({
                   traceId,
                   symbol,
                   side: analysis.recommendation,
                   confidence: analysis.confidence,
                   reasoning: `[Macro AI] ${analysis.reasoning}`,
                   agent: "MacroAgent"
                });
             }
          }
       }
    } catch (e) {
       console.error("[MacroAgent] Failed:", e);
    }
  }
}

export const macroAgent = new MacroEconomyAgent();
