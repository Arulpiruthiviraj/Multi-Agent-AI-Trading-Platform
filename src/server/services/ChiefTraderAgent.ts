import { eventBus } from '../core/EventBus';

export class ChiefTraderAgent {
  private recentIdeas: any[] = [];
  
  // Dynamic weights based on historic performance
  private agentWeights: Record<string, number> = {
    'TechnicalAgent': 1.0,
    'NewsAgent': 1.2,
    'FundamentalAgent': 1.1,
    'MacroAgent': 0.9
  };

  constructor() {
    eventBus.on('TRADE_IDEA_GENERATED', (idea) => this.reviewIdea(idea));
    
    // Periodically clear stale ideas
    setInterval(() => {
       this.recentIdeas = [];
    }, 60000);
  }

  reviewIdea(idea: { traceId: string, symbol: string, side: string, confidence: number, reasoning: string, agent: string }) {
    console.log(`[ChiefTrader] Reviewing ${idea.side} on ${idea.symbol} proposed by ${idea.agent}`);
    this.recentIdeas.push(idea);
    
    const relevantIdeas = this.recentIdeas.filter(i => i.symbol === idea.symbol);
    const agreeingIdeas = relevantIdeas.filter(i => i.side === idea.side);
    const disagreeingIdeas = relevantIdeas.filter(i => i.side !== idea.side);
    
    let weightedConfidence = 0;
    let totalWeight = 0;
    
    // Calculate consensus confidence
    for (const i of agreeingIdeas) {
       const w = this.agentWeights[i.agent] || 1.0;
       weightedConfidence += i.confidence * w;
       totalWeight += w;
    }
    
    for (const i of disagreeingIdeas) {
       const w = this.agentWeights[i.agent] || 1.0;
       weightedConfidence -= (i.confidence * w * 0.5); // Penalty for disagreement
       totalWeight += w; // Add to total weight divisor to dilute confidence
    }
    
    const finalConfidence = Math.max(0, Math.min(1, weightedConfidence / (totalWeight || 1)));
    
    let approved = false;
    let reason = "";

    const agentsAgreed = agreeingIdeas.map(i => i.agent).join(", ");
    const agentsDisagreed = disagreeingIdeas.map(i => i.agent).join(", ");

    if (finalConfidence > 0.75) {
       approved = true;
       reason = `[Chief Consensus Approval] Strong agreement. Final Confidence: ${(finalConfidence*100).toFixed(1)}%. Agreed: [${agentsAgreed}]. Disagreed: [${agentsDisagreed || 'None'}]. Primary Rationale: ${idea.reasoning}`;
    } else if (idea.agent === 'NewsAgent' && idea.confidence > 0.88) {
       approved = true;
       reason = `[Chief Fast-Track] Overriding consensus due to high-conviction news catalyst. Final Confidence: ${(finalConfidence*100).toFixed(1)}%. Rationale: ${idea.reasoning}`;
    }

    if (approved) {
       // Clear from recent so we don't duplicate
       this.recentIdeas = this.recentIdeas.filter(i => i.symbol !== idea.symbol);
       
       eventBus.emitChiefApproval({
         traceId: idea.traceId,
         symbol: idea.symbol,
         side: idea.side,
         confidence: finalConfidence,
         reasoning: reason,
         agentsContext: agentsAgreed
       });
    } else {
       console.log(`[ChiefTrader] Idea stored. Waiting for stronger consensus on ${idea.symbol}. Current confidence: ${(finalConfidence*100).toFixed(1)}%`);
    }
  }
}

export const chiefTrader = new ChiefTraderAgent();
