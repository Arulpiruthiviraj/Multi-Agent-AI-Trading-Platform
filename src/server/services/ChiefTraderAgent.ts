import { AIRouter } from '../ai/AIRouter';
import * as schema from '../db/schema';
/**
 * ==========================================================
 * Module:
 * ChiefTraderAgent.ts
 *
 * Purpose:
 * Core implementation and logic for the ChiefTraderAgent.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for ChiefTraderAgent
 * - Interface with backend APIs and EventBus
 * - Render UI components (if React)
 *
 * Inputs:
 * - Module dependencies and injected props
 *
 * Outputs:
 * - Formatted data or React Elements
 *
 * Emits:
 * - Relevant system events
 *
 * Dependencies:
 * - Standard Argus architecture layers
 *
 * Called By:
 * - Argus Routing / Parent Components
 *
 * Never:
 * - Mutate global state directly without EventBus
 * - Call AI providers directly (Must use AIRouter)
 *
 * ==========================================================
 */

import { eventBus } from '../core/EventBus';
import { db } from '../db';
import { agentPerformanceStats } from '../db/schema';

export class ChiefTraderAgent {
  private recentIdeas: any[] = [];

  // Dynamic weights based on historic performance
  private agentWeights: Record<string, number> = {
    'TechnicalAgent': 0.25,
    'FundamentalAgent': 0.20,
    'MacroAgent': 0.15,
    'NewsAgent': 0.25,
    'QuantEngine': 0.15,
    'KronosEngine': 0.20
  };

  // Guards against fanning out a fresh multi-provider debate for every single idea on the
  // same symbol within a short window (cost amplification: each debate hits every configured
  // AI provider in parallel).
  private debatingSymbols: Set<string> = new Set();
  private lastDebateAt: Map<string, number> = new Map();
  private static readonly DEBATE_COOLDOWN_MS = 60000;

  constructor() {
    eventBus.on('TRADE_IDEA_GENERATED', (idea) => this.reviewIdea(idea));
    
    setInterval(() => {
       this.recentIdeas = [];
    }, 60000);
    
    // Sync dynamic weights from database every 10 seconds
    setInterval(() => this.syncWeights(), 10000);
    this.syncWeights();
  }
  
  async syncWeights() {
    try {
        let stats = await db.select().from(agentPerformanceStats).all();
        if (stats.length === 0) {
            const defaultAgents = [
                { agentName: 'TechnicalAgent', currentWeight: 0.25, lastEvaluated: new Date().toISOString() },
                { agentName: 'FundamentalAgent', currentWeight: 0.20, lastEvaluated: new Date().toISOString() },
                { agentName: 'MacroAgent', currentWeight: 0.15, lastEvaluated: new Date().toISOString() },
                { agentName: 'NewsAgent', currentWeight: 0.25, lastEvaluated: new Date().toISOString() },
                { agentName: 'QuantEngine', currentWeight: 0.15, lastEvaluated: new Date().toISOString() },
                { agentName: 'KronosEngine', currentWeight: 0.20, lastEvaluated: new Date().toISOString() }
            ];
            for (const a of defaultAgents) {
                await db.insert(agentPerformanceStats).values(a);
            }
            stats = await db.select().from(agentPerformanceStats).all();
        }
        for (const s of stats) {
            if (s.agentName && s.currentWeight) {
                this.agentWeights[s.agentName] = s.currentWeight;
            }
        }
    } catch (e) {
        // ignore error if table is empty
    }
}

  async reviewIdea(idea: { traceId: string, symbol: string, side: string, confidence: number, reasoning: string, agent: string, newsDetails?: any, currentPrice?: number }) {
    console.log(`[ChiefTrader] Reviewing ${idea.side} on ${idea.symbol} proposed by ${idea.agent}`);
    this.recentIdeas.push(idea);
    
    // Check if we need AI Consensus Debate
    const settings = await db.select().from(schema.settings).limit(1);
    const adversarialMode = settings.length > 0 ? settings[0].adversarialDebateMode : true;

    const lastDebate = this.lastDebateAt.get(idea.symbol) || 0;
    const inCooldown = Date.now() - lastDebate < ChiefTraderAgent.DEBATE_COOLDOWN_MS;

    if (adversarialMode && idea.confidence > 0.6 && !idea.agent.includes("Consensus")) {
        if (this.debatingSymbols.has(idea.symbol) || inCooldown) {
           console.log(`[ChiefTrader] Skipping debate for ${idea.symbol}: already debating or within ${ChiefTraderAgent.DEBATE_COOLDOWN_MS / 1000}s cooldown.`);
           this.evaluateConsensus(idea.symbol, idea.traceId);
           return;
        }

        // Trigger AI debate
        console.log(`[ChiefTrader] Triggering multi-model debate for ${idea.symbol}`);
        this.debatingSymbols.add(idea.symbol);
        this.lastDebateAt.set(idea.symbol, Date.now());

        const debatePrompt = `Analyze this trading idea: ${idea.side} ${idea.symbol}. Reason: ${idea.reasoning}`;

        // This won't block the event bus, it happens asynchronously
        AIRouter.getInstance().routeConsensus("ConsensusDebate", debatePrompt, idea.traceId).then(debateResult => {
           if (debateResult && debateResult.consensus_verdict) {
              const consensusSide = debateResult.consensus_verdict;
              // NOTE: routeConsensus scores decisions on a 0-100 scale internally, but every
              // TRADE_IDEA_GENERATED / recentIdeas entry uses a 0-1 confidence scale. Pushing
              // 50/80 here previously blew past the 0-1 clamp in evaluateConsensus and
              // auto-approved almost any debated trade regardless of the other agents' votes.
              const consensusConfidence = consensusSide === "HOLD" ? 0.5 : 0.8;

              // Push the consensus as a new idea
              this.recentIdeas.push({
                 traceId: idea.traceId,
                 symbol: idea.symbol,
                 side: consensusSide,
                 confidence: consensusConfidence,
                 reasoning: `Multi-Model Debate Concluded: ${consensusSide} (Based on ${debateResult.results.length} models)`,
                 agent: 'ConsensusDebate',
                 currentPrice: idea.currentPrice
              });
              this.evaluateConsensus(idea.symbol, idea.traceId);
           }
        }).catch(err => {
           console.error("[ChiefTrader] Debate failed", err);
           this.evaluateConsensus(idea.symbol, idea.traceId);
        }).finally(() => {
           this.debatingSymbols.delete(idea.symbol);
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
            agentsAgreed = agreeingIdeas.map(i => `${i.agent}(wt:${(this.agentWeights[i.agent]||(i.agent==='ConsensusDebate'?0.35:1.0)).toFixed(2)})`).join(", ");
            agentsDisagreed = disagreeingIdeas.map(i => `${i.agent}(wt:${(this.agentWeights[i.agent]||(i.agent==='ConsensusDebate'?0.35:1.0)).toFixed(2)})`).join(", ");
            winningReason = agreeingIdeas[0]?.reasoning || "Consensus formed";
        }
    }

    let approved = false;
    let reason = "";
    
    if (bestFinalConfidence > 0.75) {
       approved = true;
       reason = `[Chief Consensus Approval] Strong agreement. Final Confidence: ${(bestFinalConfidence*100).toFixed(1)}%. Agreed: [${agentsAgreed}]. Disagreed: [${agentsDisagreed || 'None'}]. Rationale: ${winningReason}`;
    } 
    
    if (approved) {
       // Carry the most recent real price quoted by any contributing agent through to Risk.
       // Without this, downstream sizing has no live price and must refuse rather than guess.
       const priceSource = [...relevantIdeas].reverse().find(i => typeof i.currentPrice === 'number' && i.currentPrice > 0);

       // Clear from recent so we don't duplicate
       this.recentIdeas = this.recentIdeas.filter(i => i.symbol !== symbol);

       eventBus.emitChiefApproval({
         traceId: traceId,
         symbol: symbol,
         side: bestSide,
         confidence: bestFinalConfidence,
         reasoning: reason,
         agentsContext: agentsAgreed,
         currentPrice: priceSource?.currentPrice
       });
    } else {
       console.log(`[ChiefTrader] Idea stored. Waiting for stronger consensus on ${symbol}. Current confidence: ${(bestFinalConfidence*100).toFixed(1)}%`);
    }
  }

}
export const chiefTrader = new ChiefTraderAgent();


