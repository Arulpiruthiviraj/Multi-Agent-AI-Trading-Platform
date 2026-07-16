import { eventBus } from '../core/EventBus';

export class FundamentalAnalysisAgent {
  private intervalId: NodeJS.Timeout | null = null;
  private watchedSymbols = ['NVDA', 'AAPL', 'TSLA'];

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.analyzeFundamentals(), 60000); // Check every 60s
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private analyzeFundamentals() {
    const symbol = this.watchedSymbols[Math.floor(Math.random() * this.watchedSymbols.length)];
    const traceId = Math.random().toString(36).substring(7);
    
    // Simulate fundamental analysis (e.g., P/E ratio, earnings growth)
    const peRatio = 15 + Math.random() * 40;
    const epsGrowth = (Math.random() - 0.3) * 0.5; // -15% to +35%

    if (peRatio < 20 && epsGrowth > 0.15) {
      eventBus.emitTradeIdea({
        traceId,
        symbol,
        side: "BUY",
        confidence: 0.82,
        reasoning: `Strong fundamentals: P/E at ${peRatio.toFixed(1)} with EPS growth of ${(epsGrowth*100).toFixed(1)}%. Value opportunity.`,
        agent: "FundamentalAgent"
      });
    } else if (peRatio > 45 && epsGrowth < 0.05) {
      eventBus.emitTradeIdea({
        traceId,
        symbol,
        side: "SELL",
        confidence: 0.78,
        reasoning: `Overvalued fundamentals: P/E stretched to ${peRatio.toFixed(1)} while EPS growth slowed to ${(epsGrowth*100).toFixed(1)}%.`,
        agent: "FundamentalAgent"
      });
    }
  }
}

export const fundamentalAgent = new FundamentalAnalysisAgent();
