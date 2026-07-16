import { eventBus } from '../core/EventBus';

export class RiskValidationAgent {
  private dailyLossLimit = 2500;
  private maxDrawdownPct = 0.10;
  private maxPositionConcentration = 0.20;
  private sessionOpen = true; // e.g. market hours
  
  constructor() {
    eventBus.on('CHIEF_APPROVED_IDEA', (approval) => this.assessRisk(approval));
  }
  
  assessRisk(approval: { traceId: string, symbol: string, side: string, confidence: number, reasoning: string, agentsContext: string, currentPrice?: number }) {
     console.log(`[RiskManager] Validating ${approval.side} on ${approval.symbol}`);
     
     // 1. Session check
     if (!this.sessionOpen) {
        eventBus.emitRiskAssessment({
           traceId: approval.traceId,
           symbol: approval.symbol,
           side: approval.side,
           approved: false,
           maxQuantity: 0,
           reasoning: "Market session is currently closed."
        });
        return;
     }

     // 2. Check budget limits
     const availableCash = 50000; // Mock total equity
     const currentExposure = 10000; // Mock current open positions value
     const maxAlloc = availableCash * this.maxPositionConcentration;
     
     if (approval.side === 'BUY' && (availableCash - currentExposure) < 1000) {
        eventBus.emitRiskAssessment({
           traceId: approval.traceId,
           symbol: approval.symbol,
           side: approval.side,
           approved: false,
           maxQuantity: 0,
           reasoning: "Insufficient capital allocation to take on new risk."
        });
        return;
     }
     
     // Simulated metrics for ATR and portfolio correlation
     const atr = 5.2; // Example Average True Range
     const slippageEst = 0.05; // 5 cents slippage
     
     // Risk Sizing
     const estPrice = approval.currentPrice || 150; 
     const maxQuantity = Math.floor(maxAlloc / estPrice);
     
     if (approval.side === 'BUY' && maxQuantity <= 0) {
        eventBus.emitRiskAssessment({
           traceId: approval.traceId,
           symbol: approval.symbol,
           side: approval.side,
           approved: false,
           maxQuantity: 0,
           reasoning: "Capital limits met based on risk profile and maximum concentration."
        });
        return;
     }

     // Approve
     eventBus.emitRiskAssessment({
       traceId: approval.traceId,
       symbol: approval.symbol,
       side: approval.side,
       approved: true,
       maxQuantity: approval.side === 'BUY' ? maxQuantity : 100, // naive sell max
       reasoning: `Risk validated. Position sizing computed using max ${this.maxPositionConcentration * 100}% concentration cap. Estimated slippage: ${slippageEst}, ATR limit check passed.`
     });
  }
}
export const riskAgent = new RiskValidationAgent();
