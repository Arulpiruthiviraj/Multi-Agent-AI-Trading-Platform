import { eventBus } from '../core/EventBus';
import { riskEngine, PortfolioState, RiskEvaluationRequest } from '../engines/RiskEngine';

export class RiskValidationAgent {
  private sessionOpen = true; 
  
  constructor() {
    eventBus.on('CHIEF_APPROVED_IDEA', (approval) => this.assessRisk(approval));
  }
  
  assessRisk(approval: { traceId: string, symbol: string, side: string, confidence: number, reasoning: string, agentsContext: string, currentPrice?: number }) {
     console.log(`[RiskManager] Validating ${approval.side} on ${approval.symbol}`);
     
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

     const estPrice = approval.currentPrice || 150; 

     // Mock Portfolio State for Risk Engine evaluation
     // In a real system, this state is fetched from db/Alpaca sync
     const mockPortfolioState: PortfolioState = {
        totalEquity: 50000,
        availableCash: 40000,
        dailyRealizedPnL: -500, 
        maxDrawdown: 0.05,
        portfolioHeat: 0.40,
        marketRegime: 'BULL',
        openPositions: [
           { symbol: 'AAPL', quantity: 50, currentPrice: 150, volatility: 0.02 }, 
           { symbol: 'TSLA', quantity: 10, currentPrice: 250, volatility: 0.04 }  
        ]
     };

     const request: RiskEvaluationRequest = {
        symbol: approval.symbol,
        side: approval.side as 'BUY' | 'SELL',
        currentPrice: estPrice,
        confidence: approval.confidence
     };

     const result = riskEngine.evaluateRisk(request, mockPortfolioState);

     eventBus.emitRiskAssessment({
       traceId: approval.traceId,
       symbol: approval.symbol,
       side: approval.side,
       approved: result.approved,
       maxQuantity: result.maxQuantity,
       reasoning: result.reasoning
     });
  }
}

export const riskAgent = new RiskValidationAgent();
