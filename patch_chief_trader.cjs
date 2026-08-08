const fs = require('fs');
const path = 'src/server/services/ChiefTraderAgent.ts';
let content = fs.readFileSync(path, 'utf8');

const newReviewIdea = `
  async reviewIdea(idea: { traceId: string, symbol: string, side: string, confidence: number, reasoning: string, agent: string, newsDetails?: any }) {
    console.log(\`[ChiefTrader] Reviewing \${idea.side} on \${idea.symbol} proposed by \${idea.agent}\`);
    this.recentIdeas.push(idea);
    
    // Check if we need AI Consensus Debate
    const settings = await db.select().from(schema.settings).limit(1);
    const adversarialMode = settings.length > 0 ? settings[0].adversarialDebateMode : true;

    if (adversarialMode && idea.confidence > 0.6 && !idea.agent.includes("Consensus")) {
        // Trigger AI debate
        console.log(\`[ChiefTrader] Triggering multi-model debate for \${idea.symbol}\`);
        
        const debatePrompt = \`Analyze this trading idea: \${idea.side} \${idea.symbol}. Reason: \${idea.reasoning}\`;
        
        // This won't block the event bus, it happens asynchronously
        AIRouter.getInstance().routeConsensus("ConsensusDebate", debatePrompt, idea.traceId).then(debateResult => {
           if (debateResult && debateResult.consensus_verdict) {
              const consensusSide = debateResult.consensus_verdict;
              const consensusConfidence = consensusSide === "HOLD" ? 50 : 80;
              
              // Push the consensus as a new idea
              this.recentIdeas.push({
                 traceId: idea.traceId,
                 symbol: idea.symbol,
                 side: consensusSide,
                 confidence: consensusConfidence,
                 reasoning: \`Multi-Model Debate Concluded: \${consensusSide} (Based on \${debateResult.results.length} models)\`,
                 agent: 'ConsensusDebate'
              });
              this.evaluateConsensus(idea.symbol, idea.traceId);
           }
        }).catch(err => {
           console.error("[ChiefTrader] Debate failed", err);
           this.evaluateConsensus(idea.symbol, idea.traceId);
        });
    } else {
       this.evaluateConsensus(idea.symbol, idea.traceId);
    }
  }

  evaluateConsensus(symbol: string, traceId: string) {
    const relevantIdeas = this.recentIdeas.filter(i => i.symbol === symbol);
    
    // Group by side to find the strongest consensus
    const sides = ['BUY', 'SELL', 'HOLD'];
    let bestSide = 'HOLD';
    let maxWeightedConfidence = 0;
    let winningReason = '';
    let agentsAgreed = '';
    let agentsDisagreed = '';
    let bestFinalConfidence = 0;

    for (const testSide of ['BUY', 'SELL']) {
        const agreeingIdeas = relevantIdeas.filter(i => i.side === testSide);
        const disagreeingIdeas = relevantIdeas.filter(i => i.side !== testSide && i.side !== 'HOLD');
        
        let weightedConfidence = 0;
        let totalWeight = 0;
        
        for (const i of agreeingIdeas) {
           const w = this.agentWeights[i.agent] || (i.agent === 'ConsensusDebate' ? 0.35 : 1.0);
           weightedConfidence += i.confidence * w;
           totalWeight += w;
        }
        
        for (const i of disagreeingIdeas) {
           const w = this.agentWeights[i.agent] || (i.agent === 'ConsensusDebate' ? 0.35 : 1.0);
           weightedConfidence -= (i.confidence * w * 0.5); 
           totalWeight += w; 
        }
        
        const finalConfidence = Math.max(0, Math.min(1, weightedConfidence / (totalWeight || 1)));
        
        if (finalConfidence > maxWeightedConfidence) {
            maxWeightedConfidence = finalConfidence;
            bestSide = testSide;
            bestFinalConfidence = finalConfidence;
            agentsAgreed = agreeingIdeas.map(i => \`\${i.agent}(wt:\${(this.agentWeights[i.agent]||(i.agent==='ConsensusDebate'?0.35:1.0)).toFixed(2)})\`).join(", ");
            agentsDisagreed = disagreeingIdeas.map(i => \`\${i.agent}(wt:\${(this.agentWeights[i.agent]||(i.agent==='ConsensusDebate'?0.35:1.0)).toFixed(2)})\`).join(", ");
            winningReason = agreeingIdeas[0]?.reasoning || "Consensus formed";
        }
    }

    let approved = false;
    let reason = "";
    
    if (bestFinalConfidence > 0.75) {
       approved = true;
       reason = \`[Chief Consensus Approval] Strong agreement. Final Confidence: \${(bestFinalConfidence*100).toFixed(1)}%. Agreed: [\${agentsAgreed}]. Disagreed: [\${agentsDisagreed || 'None'}]. Rationale: \${winningReason}\`;
    } 
    
    if (approved) {
       // Clear from recent so we don't duplicate
       this.recentIdeas = this.recentIdeas.filter(i => i.symbol !== symbol);
       
       eventBus.emitChiefApproval({
         traceId: traceId,
         symbol: symbol,
         side: bestSide,
         confidence: bestFinalConfidence,
         reasoning: reason,
         agentsContext: agentsAgreed
       });
    } else {
       console.log(\`[ChiefTrader] Idea stored. Waiting for stronger consensus on \${symbol}. Current confidence: \${(bestFinalConfidence*100).toFixed(1)}%\`);
    }
  }
`;

content = content.replace(/reviewIdea\(idea: \{[\s\S]*?\}\n\}/, newReviewIdea.trim());

// Need to import schema and AIRouter
if (!content.includes("import { AIRouter }")) {
   content = "import { AIRouter } from '../ai/AIRouter';\nimport * as schema from '../db/schema';\n" + content;
}

fs.writeFileSync(path, content, 'utf8');
console.log('Patched ChiefTraderAgent.ts');
