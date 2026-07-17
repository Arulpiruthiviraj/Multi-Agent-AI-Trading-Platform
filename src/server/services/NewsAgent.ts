import { eventBus } from '../core/EventBus';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "mock-key" });

export class NewsIntelligenceAgent {
  private intervalId: NodeJS.Timeout | null = null;
  private watchedSymbols = ['NVDA', 'AAPL', 'TSLA'];
  
  // Real recent headlines could be injected here, we will simulate the data gathering but use real LLM for reasoning
  private mockHeadlines = [
    "Tech stocks surge as semiconductor demand outpaces supply predictions.",
    "Regulatory scrutiny increases over mega-cap tech mergers in the EU.",
    "Consumer spending drops unexpectedly, raising fears of economic slowdown.",
    "Federal reserve hints at potential rate cuts in the upcoming quarter.",
    "Major breakthrough in quantum computing announced by leading tech firm.",
    "Supply chain bottlenecks continue to plague hardware manufacturers."
  ];

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.scanHeadlines(), 45000);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async scanHeadlines() {
    const symbol = this.watchedSymbols[Math.floor(Math.random() * this.watchedSymbols.length)];
    const traceId = Math.random().toString(36).substring(7);
    const headline = this.mockHeadlines[Math.floor(Math.random() * this.mockHeadlines.length)];
    
    try {
      if (process.env.GEMINI_API_KEY) {
        const response = await ai.models.generateContent({
          model: 'gemini-3.5-flash',
          contents: `Analyze this news headline for its impact on ${symbol} stock: "${headline}". 
Return a strict JSON object matching this schema:
{
  "summary": "Brief summary of the news",
  "recommendation": "BUY" | "SELL" | "HOLD",
  "confidence": number between 0 and 1,
  "supportingEvidence": "Why this impacts the stock",
  "risks": "Potential risks to this view",
  "reasoning": "A one-sentence explanation"
}`,
          config: {
            responseMimeType: "application/json",
          }
        });

        if (response.text) {
          const analysis = JSON.parse(response.text);
          if (analysis.recommendation !== "HOLD") {
             eventBus.emitTradeIdea({
               traceId,
               symbol,
               side: analysis.recommendation,
               confidence: analysis.confidence,
               reasoning: `[NewsAgent AI Analysis] ${analysis.reasoning}`,
               agent: "NewsAgent"
             });
          }
        }
      } else {
         // Fallback if no API key
         const isBullish = Math.random() > 0.5;
         eventBus.emitTradeIdea({
            traceId,
            symbol,
            side: isBullish ? "BUY" : "SELL",
            confidence: 0.85,
            reasoning: `Fallback mocked news: ${headline}`,
            agent: "NewsAgent"
         });
      }
    } catch (e) {
      console.error("[NewsAgent] LLM parsing failed:", e);
    }
  }
}

export const newsAgent = new NewsIntelligenceAgent();
