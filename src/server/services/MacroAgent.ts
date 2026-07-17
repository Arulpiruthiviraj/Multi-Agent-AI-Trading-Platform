import { eventBus } from '../core/EventBus';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "mock-key" });

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

  private async analyzeMacro() {
    const symbol = this.watchedSymbols[Math.floor(Math.random() * this.watchedSymbols.length)];
    const traceId = Math.random().toString(36).substring(7);
    
    // Simulate macro factors
    const inflation = (2.5 + Math.random() * 2).toFixed(1);
    const fedFundsRate = (4.0 + (Math.random() > 0.5 ? 0.25 : -0.25)).toFixed(2);
    const unemployment = (3.5 + Math.random()).toFixed(1);

    try {
       if (process.env.GEMINI_API_KEY) {
          const response = await ai.models.generateContent({
             model: 'gemini-3.5-flash',
             contents: `Analyze these macroeconomic indicators for their impact on large-cap equities like ${symbol}: CPI Inflation ${inflation}%, Fed Funds Rate ${fedFundsRate}%, Unemployment ${unemployment}%.
Return a strict JSON object matching this schema:
{
  "summary": "Brief summary",
  "recommendation": "BUY" | "SELL" | "HOLD",
  "confidence": number between 0 and 1,
  "supportingEvidence": "Key macro drivers",
  "risks": "Macro risks",
  "reasoning": "A one-sentence explanation"
}`,
             config: { responseMimeType: "application/json" }
          });
          
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
       } else {
           eventBus.emitTradeIdea({
              traceId, symbol, side: "BUY", confidence: 0.75, reasoning: "Fallback Macro BUY", agent: "MacroAgent"
           });
       }
    } catch (e) {
       console.error("[MacroAgent] LLM parsing failed:", e);
    }
  }
}

export const macroAgent = new MacroEconomyAgent();
