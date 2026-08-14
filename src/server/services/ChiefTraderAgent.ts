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
import { agentPerformanceStats, agentConfidenceCalibration } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { EvidenceAggregator, Evidence } from './EvidenceAggregator';
import { bucketFor } from './ConfidenceCalibration';
import { shouldTriggerOpenAliceVerification } from '../ai/EscalationPolicy';
import { openAliceVerificationService } from '../integrations/openalice/OpenAliceVerificationService';
import { recordConsensusTransaction } from '../core/TransactionRegistry';
import { STRATEGY_TYPICAL_HOLDING_PERIOD } from '../quant/strategies/types';

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

  /**
   * Phase 8 of the additive quant layer - assembles the real structured quant detail for
   * CHIEF_APPROVED_IDEA when the QuantEngine contributed evidence for this approval.
   * `quantDetail` is attached (via TRADE_IDEA_GENERATED, QuantSignalAgent.ts) to the specific
   * evidence entry it came from - `evidence` here is a real runtime superset of the typed
   * `Evidence[]` shape (every idea object retains whatever extra fields it was emitted with, even
   * though the `Evidence` interface doesn't declare them), so this reads `(e as any).quantDetail`
   * rather than widening that shared interface for one agent's own extra payload. Returns null
   * (never a fabricated structure) when no contributing agent this round was QuantEngine.
   */
  private buildSupportingQuantDetail(evidence: Evidence[], currentPrice: number | undefined): any {
    const quantEvidence = evidence.find((e: any) => e.quantDetail) as any;
    if (!quantEvidence) return null;
    const { regime, strategyEvaluation, groupedScores, contradictions, aiContradictionAnalysis } = quantEvidence.quantDetail;

    return {
      regime,
      selectedStrategy: strategyEvaluation?.strategy ?? null,
      setupScores: groupedScores,
      contradictions: [
        ...(contradictions ?? []),
        ...(aiContradictionAnalysis?.additionalContradictions ?? []),
      ],
      invalidationConditions: strategyEvaluation?.invalidationConditions ?? [],
      proposedEntry: currentPrice ?? null,
      // Phase 16F (ARGUS_PHASE16_READINESS_REPORT.md) - real bug fix found via a real TypeScript
      // error while wiring a live consumer of these two fields for the first time (Phase 16B/16F):
      // strategyEvaluation.stop/.target are LevelSuggestion objects ({price, basis}), not numbers -
      // this was passing the whole object through as "proposedStop"/"proposedTarget" since this
      // method was first written (pre-existing, predates this session's Phase 16 work). Nothing
      // downstream actually READ these two fields as numbers until Phase 16B, so the bug was real
      // but silent - it would have stored non-numeric garbage into `trades.quantStopPrice`/
      // `quantTargetPrice` the first time a real QuantEngine strategy trade executed live.
      proposedStop: strategyEvaluation?.stop?.price ?? null,
      proposedTarget: strategyEvaluation?.target?.price ?? null,
      expectedHoldingPeriod: strategyEvaluation ? STRATEGY_TYPICAL_HOLDING_PERIOD[strategyEvaluation.strategy] ?? null : null,
      aiReview: aiContradictionAnalysis?.available ? {
        agreesWithSide: aiContradictionAnalysis.aiAgreesWithSide,
        scenarioAnalysis: aiContradictionAnalysis.scenarioAnalysis,
        disagreementNote: aiContradictionAnalysis.disagreementNote,
      } : null,
    };
  }

  /**
   * Phase 1A - real Beta-Binomial calibration lookup (ConfidenceCalibration.ts). Distinct from
   * resolveWeight() above: that's a flat, agent-wide scalar from OVERALL win rate; this corrects
   * THIS SPECIFIC stated confidence against the agent's own real historical accuracy at that
   * exact confidence level. Falls back to the raw stated confidence unchanged when no real
   * evaluated history exists yet for this agent/bucket - never fabricates a calibration out of
   * zero data (the Beta-Binomial prior itself already handles thin samples gracefully; a missing
   * row just means literally zero real outcomes have ever been evaluated for this bucket).
   */
  private async calibrateConfidence(agentName: string, rawConfidence: number): Promise<number> {
    try {
      const bucket = bucketFor(rawConfidence);
      const rows = await db.select().from(agentConfidenceCalibration).where(
        and(eq(agentConfidenceCalibration.agentName, agentName), eq(agentConfidenceCalibration.bucketLow, bucket.low))
      );
      return rows[0] ? rows[0].calibratedConfidence : rawConfidence;
    } catch (e) {
      console.error('[ChiefTrader] Confidence calibration lookup failed - using raw confidence', e);
      return rawConfidence;
    }
  }

  async evaluateConsensus(symbol: string, traceId: string) {
    eventBus.emit('CHIEF_CONSENSUS_STARTED', { traceId, symbol, ideaCount: this.recentIdeas.filter(i => i.symbol === symbol).length });

    const relevantIdeas = this.recentIdeas.filter(i => i.symbol === symbol);
    const evidence: Evidence[] = await Promise.all(relevantIdeas.map(async i => ({
      ...i,
      confidence: await this.calibrateConfidence(i.agent, i.confidence),
      weight: this.resolveWeight(i.agent),
    })));

    const result = EvidenceAggregator.aggregate(evidence);
    const agentsAgreed = result.agreements.map(e => `${e.agent}(wt:${e.weight.toFixed(2)})`).join(", ");
    const agentsDisagreed = result.disagreements.map(e => `${e.agent}(wt:${e.weight.toFixed(2)})`).join(", ");

    let approved = false;
    let reason = "";

    if (result.confidence > CONSENSUS_APPROVAL_THRESHOLD) {
       approved = true;
       reason = `[Chief Consensus Approval] Strong agreement. Final Confidence: ${(result.confidence*100).toFixed(1)}%. Agreed: [${agentsAgreed}]. Disagreed: [${agentsDisagreed || 'None'}]. Rationale: ${result.reasoning}`;
    }

    // Unconditional COMPLETED signal (unlike CHIEF_APPROVED_IDEA, which only fires on approval) -
    // lets live animation show the Chief Trader node finishing its evaluation even when the
    // result is "not yet, waiting for more evidence," not just on a successful approval.
    eventBus.emit('CHIEF_CONSENSUS_COMPLETED', { traceId, symbol, approved, confidence: result.confidence, side: result.side, threshold: CONSENSUS_APPROVAL_THRESHOLD });

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
         // Phase 8 of the additive quant layer - real structured quant detail (selected strategy,
         // regime, setup scores, contradictions, invalidation conditions, proposed entry/stop/
         // target, expected holding period, real AI qualitative review) when the QuantEngine
         // contributed evidence for this symbol. Additive only - existing consumers of
         // CHIEF_APPROVED_IDEA that don't read this new field are completely unaffected, and
         // RiskEngine's own gate ladder (which reads RISK_ASSESSMENT_COMPLETED, not this event
         // directly) is never bypassed or altered by anything in this field.
         supportingQuantDetail: this.buildSupportingQuantDetail(evidence, result.currentPrice),
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
      const evidence: Evidence[] = await Promise.all(relevantIdeas.map(async i => ({
        ...i,
        confidence: await this.calibrateConfidence(i.agent, i.confidence),
        weight: this.resolveWeight(i.agent),
      })));
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


