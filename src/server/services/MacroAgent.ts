import { eventBus } from '../core/EventBus';

export class MacroEconomyAgent {
  private intervalId: NodeJS.Timeout | null = null;
  private watchedSymbols = ['NVDA', 'AAPL', 'TSLA']; // Example symbols influenced by macro

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.analyzeMacro(), 75000); // Check every 75s
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private analyzeMacro() {
    const symbol = this.watchedSymbols[Math.floor(Math.random() * this.watchedSymbols.length)];
    const traceId = Math.random().toString(36).substring(7);
    
    // Simulate macro analysis (e.g., interest rates, inflation)
    const fedHawkish = Math.random() > 0.6;
    const inflationHigh = Math.random() > 0.5;

    if (!fedHawkish && !inflationHigh) {
      eventBus.emitTradeIdea({
        traceId,
        symbol,
        side: "BUY",
        confidence: 0.75,
        reasoning: `Favorable macro environment: Dovish Fed and cooling inflation support risk assets like ${symbol}.`,
        agent: "MacroAgent"
      });
    } else if (fedHawkish && inflationHigh) {
      eventBus.emitTradeIdea({
        traceId,
        symbol,
        side: "SELL",
        confidence: 0.80,
        reasoning: `Hostile macro environment: Hawkish Fed fighting sticky inflation. High risk for ${symbol}.`,
        agent: "MacroAgent"
      });
    }
  }
}

export const macroAgent = new MacroEconomyAgent();
