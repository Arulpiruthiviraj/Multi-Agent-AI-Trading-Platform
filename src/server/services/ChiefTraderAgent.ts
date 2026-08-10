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
import { EvidenceAggregator, Evidence } from './EvidenceAggregator';
import { shouldTriggerOpenAliceVerification } from '../ai/EscalationPolicy';
import { openAliceVerificationService } from '../integrations/openalice/OpenAliceVerificationService';
import { recordConsensusTransaction } from '../core/TransactionRegistry';

const CONSENSUS_APPROVAL_THRESHOLD = 0.75;

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

  constructor() {
    eventBus.on('TRADE_IDEA_GENERATED', (idea) => this.reviewIdea(idea));

    setInterval(() => {
       this.recordUnresolvedAsNoConsensus().catch(e => console.error('[ChiefTrader] Failed to record NO_CONSENSUS transactions', e));
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

  async reviewIdea(idea: { traceId: string, symbol: string, side: string, confidence: number, reasoning: string, agent: string, currentPrice?: number, newsDetails?: any }) {
    console.log(`[ChiefTrader] Reviewing ${idea.side} on ${idea.symbol} proposed by ${idea.agent}`);
    this.recentIdeas.push(idea);
    
    // Check if we need AI Consensus Debate
    const settings = await db.select().from(schema.settings).limit(1);
    const adversarialMode = settings.length > 0 ? settings[0].adversarialDebateMode : true;

    if (adversarialMode && idea.confidence > 0.6 && !idea.agent.includes("Consensus")) {
        // Trigger AI debate
        console.log(`[ChiefTrader] Triggering multi-model debate for ${idea.symbol}`);
        
        const debatePrompt = `Analyze this trading idea: ${idea.side} ${idea.symbol}. Reason: ${idea.reasoning}`;
        
        // This won't block the event bus, it happens asynchronously
        AIRouter.getInstance().routeConsensus("ConsensusDebate", debatePrompt, idea.traceId).then(debateResult => {
           if (debateResult && debateResult.consensus_verdict) {
              const consensusSide = debateResult.consensus_verdict;
              // Confidence is 0-1 scale everywhere else in the consensus math below
              // (weightedConfidence / totalWeight, clamped to [0,1]) - this was 50/80.
              const consensusConfidence = consensusSide === "HOLD" ? 0.5 : 0.8;
              
              // Push the consensus as a new idea
              this.recentIdeas.push({
                 traceId: idea.traceId,
                 symbol: idea.symbol,
                 side: consensusSide,
                 confidence: consensusConfidence,
                 currentPrice: idea.currentPrice,
                 reasoning: `Multi-Model Debate Concluded: ${consensusSide} (Based on ${debateResult.results.length} models)`,
                 agent: 'ConsensusDebate'
              });
              this.evaluateConsensus(idea.symbol, idea.traceId).catch(e => console.error('[ChiefTrader] evaluateConsensus failed', e));
           }
        }).catch(err => {
           console.error("[ChiefTrader] Debate failed", err);
           this.evaluateConsensus(idea.symbol, idea.traceId).catch(e => console.error('[ChiefTrader] evaluateConsensus failed', e));
        });
    } else {
       this.evaluateConsensus(idea.symbol, idea.traceId).catch(e => console.error('[ChiefTrader] evaluateConsensus failed', e));
    }
  }

  private resolveWeight(agentName: string): number {
    return this.agentWeights[agentName] || (agentName === 'ConsensusDebate' ? 0.35 : 1.0);
  }

  async evaluateConsensus(symbol: string, traceId: string) {
    const relevantIdeas = this.recentIdeas.filter(i => i.symbol === symbol);
    const evidence: Evidence[] = relevantIdeas.map(i => ({ ...i, weight: this.resolveWeight(i.agent) }));

    const result = EvidenceAggregator.aggregate(evidence);
    const agentsAgreed = result.agreements.map(e => `${e.agent}(wt:${e.weight.toFixed(2)})`).join(", ");
    const agentsDisagreed = result.disagreements.map(e => `${e.agent}(wt:${e.weight.toFixed(2)})`).join(", ");

    let approved = false;
    let reason = "";

    if (result.confidence > CONSENSUS_APPROVAL_THRESHOLD) {
       approved = true;
       reason = `[Chief Consensus Approval] Strong agreement. Final Confidence: ${(result.confidence*100).toFixed(1)}%. Agreed: [${agentsAgreed}]. Disagreed: [${agentsDisagreed || 'None'}]. Rationale: ${result.reasoning}`;
    }

    if (approved) {
       // Clear from recent so we don't duplicate
       this.recentIdeas = this.recentIdeas.filter(i => i.symbol !== symbol);

       // Mint the canonical transaction id and persist the consensus math + every contributing
       // agent's evidence as real rows (TRANSACTION_OBSERVATORY_ARCHITECTURE.md Phase 0) - fixes
       // the bug where only the ONE triggering idea's self-generated traceId survived downstream,
       // orphaning every other contributing agent's evidence under its own different id.
       const transactionId = await recordConsensusTransaction({
         symbol,
         side: result.side,
         weightedConfidence: result.confidence,
         threshold: CONSENSUS_APPROVAL_THRESHOLD,
         approved: true,
         reasoning: reason,
         evidence: evidence.map(e => ({
           sourceTraceId: e.traceId,
           agent: e.agent,
           side: e.side,
           confidence: e.confidence,
           weight: e.weight,
           reasoning: e.reasoning,
           currentPrice: e.currentPrice,
         })),
       });

       eventBus.emitChiefApproval({
         transactionId,
         traceId: traceId,
         symbol: symbol,
         side: result.side,
         confidence: result.confidence,
         currentPrice: result.currentPrice,
         reasoning: reason,
         agentsContext: agentsAgreed,
         // Structured evidence alongside the existing formatted string - lets a future trace
         // viewer/ExplainabilityAgent show per-agent side/confidence/weight without re-parsing text.
         evidence: evidence.map(e => ({ agent: e.agent, side: e.side, confidence: e.confidence, weight: e.weight, reasoning: e.reasoning })),
       });

       // Non-blocking, optional independent second opinion (OPENALICE_INTEGRATION_AUDIT.md Phase 3/4).
       // Fire-and-forget: never awaited, never gates this approval or the RiskEngine call that
       // follows it. A no-op when OpenAlice isn't configured (see OpenAliceVerificationService).
       // Its eventual result (which can take minutes) only ever feeds FUTURE decisions.
       const openAliceTrigger = shouldTriggerOpenAliceVerification({
         confidence: result.confidence,
         disagreementCount: result.disagreements.length,
       });
       if (openAliceTrigger.shouldVerify && result.side !== 'HOLD') {
         openAliceVerificationService.requestVerification({
           traceId,
           symbol,
           side: result.side,
           mode: 'TRADE_VERIFICATION',
           argusConfidence: result.confidence,
           argusReasoning: result.reasoning,
         });
       }
    } else {
       console.log(`[ChiefTrader] Idea stored. Waiting for stronger consensus on ${symbol}. Current confidence: ${(result.confidence*100).toFixed(1)}%`);
    }
  }

  /**
   * Called just before the 60s recentIdeas clear. Any symbol still holding accumulated ideas
   * that never crossed CONSENSUS_APPROVAL_THRESHOLD gets a real NO_CONSENSUS transaction row -
   * otherwise that attempt (and the evidence behind it) would simply vanish with no record,
   * making "why didn't Argus trade AAPL even though 3 agents said BUY" unanswerable.
   */
  private async recordUnresolvedAsNoConsensus() {
    const symbols = Array.from(new Set(this.recentIdeas.map(i => i.symbol)));
    for (const symbol of symbols) {
      const relevantIdeas = this.recentIdeas.filter(i => i.symbol === symbol);
      if (relevantIdeas.length === 0) continue;
      const evidence: Evidence[] = relevantIdeas.map(i => ({ ...i, weight: this.resolveWeight(i.agent) }));
      const result = EvidenceAggregator.aggregate(evidence);

      await recordConsensusTransaction({
        symbol,
        side: result.side,
        weightedConfidence: result.confidence,
        threshold: CONSENSUS_APPROVAL_THRESHOLD,
        approved: false,
        reasoning: `No consensus reached before the evaluation window closed. Best side: ${result.side} at ${(result.confidence * 100).toFixed(1)}% (threshold ${(CONSENSUS_APPROVAL_THRESHOLD * 100).toFixed(0)}%).`,
        evidence: evidence.map(e => ({
          sourceTraceId: e.traceId,
          agent: e.agent,
          side: e.side,
          confidence: e.confidence,
          weight: e.weight,
          reasoning: e.reasoning,
          currentPrice: e.currentPrice,
        })),
      });
    }
  }

}
export const chiefTrader = new ChiefTraderAgent();


