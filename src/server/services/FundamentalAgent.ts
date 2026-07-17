import { eventBus } from '../core/EventBus';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "mock-key" });

export class FundamentalAnalysisAgent {
  private intervalId: NodeJS.Timeout | null = null;
  private watchedSymbols = ['NVDA', 'AAPL', 'TSLA'];

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.analyzeFundamentals(), 60000);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async analyzeFundamentals() {
    const symbol = this.watchedSymbols[Math.floor(Math.random() * this.watchedSymbols.length)];
    const traceId = Math.random().toString(36).substring(7);
    
    // Simulate fetching fundamental data
    const peRatio = (15 + Math.random() * 40).toFixed(2);
    const epsGrowth = ((Math.random() - 0.3) * 0.5 * 100).toFixed(2);
    const debtToEquity = (Math.random() * 2).toFixed(2);
    
    try {
       if (process.env.GEMINI_API_KEY) {
          const response = await ai.models.generateContent({
             model: 'gemini-3.5-flash',
             contents: `Analyze these fundamentals for ${symbol}: P/E Ratio: ${peRatio}, EPS Growth: ${epsGrowth}%, Debt/Equity: ${debtToEquity}.
Return a strict JSON object matching this schema:
{
  "summary": "Brief summary",
  "recommendation": "BUY" | "SELL" | "HOLD",
  "confidence": number between 0 and 1,
  "supportingEvidence": "Key fundamental drivers",
  "risks": "Fundamental risks",
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
                   reasoning: `[Fundamental AI] ${analysis.reasoning}`,
                   agent: "FundamentalAgent"
                });
             }
          }
       } else {
           if (parseFloat(peRatio) < 20) {
              eventBus.emitTradeIdea({
                 traceId, symbol, side: "BUY", confidence: 0.8, reasoning: "Fallback fundamental BUY", agent: "FundamentalAgent"
              });
           }
       }
    } catch (e) {
       console.error("[FundamentalAgent] LLM parsing failed:", e);
    }
  }
}

export const fundamentalAgent = new FundamentalAnalysisAgent();
