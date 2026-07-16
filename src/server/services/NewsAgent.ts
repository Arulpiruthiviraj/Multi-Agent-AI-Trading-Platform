import { eventBus } from '../core/EventBus';

export class NewsIntelligenceAgent {
  private intervalId: NodeJS.Timeout | null = null;
  private watchedSymbols = ['NVDA', 'AAPL', 'TSLA'];

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.scanHeadlines(), 45000); // Check every 45s
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private scanHeadlines() {
    // Simulated news scraping
    const symbol = this.watchedSymbols[Math.floor(Math.random() * this.watchedSymbols.length)];
    const isBullish = Math.random() > 0.5;
    const traceId = Math.random().toString(36).substring(7);
    
    if (isBullish) {
      const headlines = [
        `Analysts upgrade ${symbol} price target on strong demand.`,
        `${symbol} announces breakthrough in new product line.`,
        `Earnings beat expectations for ${symbol} with strong guidance.`
      ];
      const headline = headlines[Math.floor(Math.random() * headlines.length)];
      console.log(`[NewsAgent] Bullish news detected: ${headline}`);
      
      eventBus.emitTradeIdea({
        traceId,
        symbol,
        side: "BUY",
        confidence: 0.90,
        reasoning: `Positive news catalyst: "${headline}". High probability of short-term rally.`,
        agent: "NewsAgent"
      });
    } else {
      const headlines = [
        `Regulatory concerns pressure ${symbol} shares.`,
        `${symbol} faces supply chain delays, analysts warn.`,
        `Macro headwinds create uncertainty for ${symbol}.`
      ];
      const headline = headlines[Math.floor(Math.random() * headlines.length)];
      console.log(`[NewsAgent] Bearish news detected: ${headline}`);
      
      eventBus.emitTradeIdea({
        traceId,
        symbol,
        side: "SELL",
        confidence: 0.85,
        reasoning: `Negative news catalyst: "${headline}". Risk of downside correction.`,
        agent: "NewsAgent"
      });
    }
  }
}

export const newsAgent = new NewsIntelligenceAgent();
