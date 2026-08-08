/**
 * ==========================================================
 * Module: FundamentalAgent.ts
 *
 * Purpose:
 * Evaluates real fundamental data if available.
 * ==========================================================
 */
import { eventBus } from '../core/EventBus';
import { AIRouter } from '../ai/AIRouter';
import crypto from 'crypto';

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

  private async fetchFundamentals(symbol: string) {
    if (!process.env.ALPHAVANTAGE_API_KEY) {
      return {
        peRatio: "UNKNOWN",
        epsGrowth: "UNKNOWN",
        debtToEquity: "UNKNOWN"
      };
    }

    try {
      const response = await fetch(`https://www.alphavantage.co/query?function=OVERVIEW&symbol=${symbol}&apikey=${process.env.ALPHAVANTAGE_API_KEY}`);
      const data = await response.json() as any;

      if (data && data.PERatio) {
        return {
          peRatio: data.PERatio,
          epsGrowth: data.QuarterlyEarningsGrowthYOY || "UNKNOWN",
          debtToEquity: data.DebtToEquity || "UNKNOWN"
        };
      }
    } catch (e) {
      console.error("[FundamentalAgent] AlphaVantage fetch failed:", e);
    }

    return {
      peRatio: "UNKNOWN",
      epsGrowth: "UNKNOWN",
      debtToEquity: "UNKNOWN"
    };
  }

  private async analyzeFundamentals() {
    // We just pick a symbol round-robin or randomly from our list
    const symbol = this.watchedSymbols[Math.floor(Date.now() / 60000) % this.watchedSymbols.length];
    const traceId = crypto.randomUUID();
    
    try {
       const data = await this.fetchFundamentals(symbol);
       
       if (data.peRatio === "UNKNOWN") {
          eventBus.emitTradeIdea({
             traceId, 
             symbol, 
             side: "HOLD", 
             confidence: 0, 
             reasoning: "DATA_UNAVAILABLE: Fundamental data providers not configured.", 
             agent: "FundamentalAgent"
          });
          return;
       }

       if (process.env.GEMINI_API_KEY) {
          const res = await AIRouter.getInstance().routeTask('FundamentalAgent', `Analyze these fundamentals for ${symbol}: P/E Ratio: ${data.peRatio}, EPS Growth: ${data.epsGrowth}%, Debt/Equity: ${data.debtToEquity}. Return strict JSON: { summary, recommendation, confidence, supportingEvidence, risks, reasoning }`, traceId);
          const response = { text: res.content };
          
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
       }
    } catch (e) {
       console.error("[FundamentalAgent] Failed:", e);
    }
  }
}

export const fundamentalAgent = new FundamentalAnalysisAgent();
