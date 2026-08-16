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
import { eq, and, desc } from 'drizzle-orm';
import { EvidenceAggregator, Evidence } from './EvidenceAggregator';
import { bucketFor } from './ConfidenceCalibration';
import { shouldTriggerOpenAliceVerification } from '../ai/EscalationPolicy';
import { openAliceVerificationService } from '../integrations/openalice/OpenAliceVerificationService';
import { recordConsensusTransaction } from '../core/TransactionRegistry';
import { STRATEGY_TYPICAL_HOLDING_PERIOD } from '../quant/strategies/types';
import { tradingSafety } from '../config/tradingSafety';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { agentWeightConfig, defaultAgentWeights } from '../config/agentWeights';
import { EVENTS } from '../core/eventNames';
import { parseResearchNote, isBullBearResearchEnabled } from '../ai/research/parseResearchNote';
import { bullBearResearchConfig } from '../config/bullBearResearch';
import { recordPitLive } from '../engines/backtest/PitLedgerRecorder';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';

export const CONSENSUS_APPROVAL_THRESHOLD = tradingSafety.consensusApprovalThreshold;
/** A professional trader does not act on a single voice. ConsensusDebate is a challenge of
 *  existing evidence, not an independent source, so it does not count toward this floor. */
export const MIN_INDEPENDENT_AGREEING_AGENTS = tradingSafety.minIndependentAgreeingAgents;
const RISK_EXIT_AGENT = agentWeightConfig.riskExitAgent;

async function loadDebateLearnedRulesText(): Promise<string> {
  try {
    const rows = await db.select().from(schema.learnedRules)
      .orderBy(desc(schema.learnedRules.timestamp))
      .limit(tradingSafety.debateLearnedRulesCount);
    if (!rows.length) return '';
    const maxChars = tradingSafety.debateLearnedRuleMaxChars;
    const lines = rows.map((r, i) => `${i + 1}. ${(r.rule || '').slice(0, maxChars)}`);
    return `\nRecent learned rules (text only; they do not override RiskEngine):\n${lines.join('\n')}`;
  } catch (e) {
    console.warn('[ChiefTrader] Failed to load learned_rules for debate prompt', e);
    return '';
  }
}

function parseLlmJson(content: string | undefined): unknown {
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export class ChiefTraderAgent {
  private recentIdeas: any[] = [];
  /** Per-symbol count of in-flight adversarial debates. evaluateConsensus must not run for a
   *  symbol while this is > 0 - otherwise a later low-confidence idea (or a second agent)
   *  would approve the trade before the debate that was supposed to challenge it finished. */
  private pendingDebates: Map<string, number> = new Map();
  
  // Dynamic weights based on historic performance
  private agentWeights: Record<string, number> = { ...defaultAgentWeights };

  constructor() {
    eventBus.on('TRADE_IDEA_GENERATED', (idea) => this.reviewIdea(idea));

    setInterval(() => {
       this.recordUnresolvedAsNoConsensus().catch(e => console.error('[ChiefTrader] Failed to record NO_CONSENSUS transactions', e));
       // Keep ideas for symbols whose debate is still in flight - wiping them would make the
       // eventual debate completion evaluate an empty set and silently drop the original thesis.
       this.recentIdeas = this.recentIdeas.filter(i => (this.pendingDebates.get(i.symbol) || 0) > 0);
    }, runtimeIntervals.chiefTraderIdeaTtlMs);
    
    // Sync dynamic weights from database every 10 seconds
    setInterval(() => this.syncWeights(), runtimeIntervals.chiefTraderWeightSyncMs);
    this.syncWeights();
  }
  
  async syncWeights() {
    try {
        let stats = await db.select().from(agentPerformanceStats).all();
        if (stats.length === 0) {
            const defaultAgents = Object.entries(defaultAgentWeights).map(([agentName, currentWeight]) => ({
                agentName,
                currentWeight,
                lastEvaluated: new Date().toISOString(),
            }));
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

  private isRiskExit(idea: { agent: string, side: string }): boolean {
    return idea.agent === RISK_EXIT_AGENT && idea.side === 'SELL';
  }

  private beginDebate(symbol: string): void {
    this.pendingDebates.set(symbol, (this.pendingDebates.get(symbol) || 0) + 1);
  }

  private endDebate(symbol: string): void {
    const next = (this.pendingDebates.get(symbol) || 1) - 1;
    if (next <= 0) this.pendingDebates.delete(symbol);
    else this.pendingDebates.set(symbol, next);
  }

  private debatePending(symbol: string): boolean {
    return (this.pendingDebates.get(symbol) || 0) > 0;
  }

  private pushDebateFailClosed(idea: { traceId: string, symbol: string, currentPrice?: number }, why: string): void {
    this.recentIdeas.push({
      traceId: idea.traceId,
      symbol: idea.symbol,
      side: 'HOLD',
      confidence: tradingSafety.debateResultConfidence,
      currentPrice: idea.currentPrice,
      reasoning: `Multi-Model Debate fail-closed HOLD (${why}). Adversarial debate did not produce a usable verdict.`,
      agent: 'ConsensusDebate',
    });
  }

  async reviewIdea(idea: { traceId: string, symbol: string, side: string, confidence: number, reasoning: string, agent: string, currentPrice?: number, newsDetails?: any }) {
    // Autobot-off: do not debate stray entry ideas (no LLM, no CHIEF_APPROVED_IDEA).
    // PortfolioMonitor risk-exit SELLs still proceed — capital preservation is not an entry vote.
    if (!isLiveIdeaGenerationEnabled() && !this.isRiskExit(idea)) {
      console.log(`[ChiefTrader] Ignoring ${idea.agent} ${idea.side} ${idea.symbol} — Autobot off or trading not TRADING_ENABLED`);
      return;
    }
    console.log(`[ChiefTrader] Reviewing ${idea.side} on ${idea.symbol} proposed by ${idea.agent}`);
    this.recentIdeas.push(idea);

    // PortfolioMonitor stop/target/invalidation exits must not wait for a multi-model debate or
    // for a second independent entry agent - capital preservation is not a consensus question.
    if (this.isRiskExit(idea)) {
      this.evaluateConsensus(idea.symbol, idea.traceId).catch(e => console.error('[ChiefTrader] evaluateConsensus failed', e));
      return;
    }

    const settings = await db.select().from(schema.settings).limit(1);
    const adversarialMode = settings.length > 0 ? settings[0].adversarialDebateMode : true;

    if (adversarialMode && idea.confidence > tradingSafety.debateTriggerConfidence && !idea.agent.includes("Consensus")) {
        console.log(`[ChiefTrader] Triggering multi-model debate for ${idea.symbol}`);
        this.beginDebate(idea.symbol);

        const learnedRulesText = await loadDebateLearnedRulesText();
        let researchBlock = '';
        if (isBullBearResearchEnabled()) {
          try {
            const router = AIRouter.getInstance();
            const fieldList = bullBearResearchConfig.requiredFields.join(', ');
            const context = `Idea: ${idea.side} ${idea.symbol}. Reason: ${idea.reasoning}. Return JSON with fields: ${fieldList}. Do not invent numeric market facts.`;
            const [bullRes, bearRes] = await Promise.all([
              router.routeTask(bullBearResearchConfig.bullAgentName, `${bullBearResearchConfig.bullRole}\n${context}`, idea.traceId, true),
              router.routeTask(bullBearResearchConfig.bearAgentName, `${bullBearResearchConfig.bearRole}\n${context}`, idea.traceId, true),
            ]);
            const bullNote = parseResearchNote(parseLlmJson(bullRes?.content), 'BULL');
            const bearNote = parseResearchNote(parseLlmJson(bearRes?.content), 'BEAR');
            researchBlock = `\n${bullBearResearchConfig.bullAgentName}: ${bullNote.thesisSummary}\n${bullBearResearchConfig.bearAgentName}: ${bearNote.thesisSummary}`;
            if (bearNote.confidence >= bullBearResearchConfig.bearHoldMinConfidence) {
              this.recentIdeas.push({
                traceId: idea.traceId,
                symbol: idea.symbol,
                side: 'HOLD',
                confidence: bearNote.confidence,
                currentPrice: idea.currentPrice,
                reasoning: `[${bullBearResearchConfig.bearAgentName}] ${bearNote.thesisSummary || bearNote.invalidationCondition}`,
                agent: bullBearResearchConfig.bearAgentName,
              });
            }
          } catch (e) {
            console.warn('[ChiefTrader] Bull/Bear research failed - debate continues without it', e);
          }
        }

        const debatePrompt = `Analyze this trading idea: ${idea.side} ${idea.symbol}. Reason: ${idea.reasoning}.${learnedRulesText}${researchBlock} Actively search for reasons NOT to trade. If the setup is poor, verdict must be HOLD.`;

        AIRouter.getInstance().routeConsensus("ConsensusDebate", debatePrompt, idea.traceId).then(debateResult => {
           if (debateResult && debateResult.consensus_verdict) {
              const consensusSide = debateResult.consensus_verdict;
              const consensusConfidence = tradingSafety.debateResultConfidence;

              this.recentIdeas.push({
                 traceId: idea.traceId,
                 symbol: idea.symbol,
                 side: consensusSide,
                 confidence: consensusConfidence,
                 currentPrice: idea.currentPrice,
                 reasoning: `Multi-Model Debate Concluded: ${consensusSide} (Based on ${debateResult.results.length} models)`,
                 agent: 'ConsensusDebate'
              });
           } else {
              console.warn(`[ChiefTrader] Debate for ${idea.symbol} returned no verdict - fail-closed HOLD (do not approve without a debate vote).`);
              this.pushDebateFailClosed(idea, 'no verdict');
           }
        }).catch(err => {
           console.error("[ChiefTrader] Debate failed", err);
           this.pushDebateFailClosed(idea, 'routeConsensus threw');
        }).finally(() => {
           this.endDebate(idea.symbol);
           if (!this.debatePending(idea.symbol)) {
             this.evaluateConsensus(idea.symbol, idea.traceId).catch(e => console.error('[ChiefTrader] evaluateConsensus failed', e));
           }
        });
    } else if (this.debatePending(idea.symbol)) {
       console.log(`[ChiefTrader] Debate still in flight for ${idea.symbol} - storing ${idea.agent}'s idea and waiting before evaluating consensus.`);
    } else {
       this.evaluateConsensus(idea.symbol, idea.traceId).catch(e => console.error('[ChiefTrader] evaluateConsensus failed', e));
    }
  }

  private resolveWeight(agentName: string): number {
    return this.agentWeights[agentName] || (agentName === 'ConsensusDebate' ? agentWeightConfig.consensusDebateWeight : agentWeightConfig.unlistedAgentWeight);
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
    const structure = regime?.features?.trend?.structure;
    const side = quantEvidence.side === 'SELL' ? 'SELL' : 'BUY';
    const structuralLevel = side === 'BUY'
      ? (structure?.lastSwingHigh ?? strategyEvaluation?.stop?.price ?? null)
      : (structure?.lastSwingLow ?? strategyEvaluation?.stop?.price ?? null);

    return {
      regime,
      selectedStrategy: strategyEvaluation?.strategy ?? null,
      setupScores: groupedScores,
      contradictions: [
        ...(contradictions ?? []),
        ...(aiContradictionAnalysis?.additionalContradictions ?? []),
      ],
      invalidationConditions: strategyEvaluation?.invalidationConditions ?? [],
      applicableRegimes: strategyEvaluation?.applicableRegimes ?? [],
      entryRegime: regime?.regime ?? null,
      structuralLevel,
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
      featureSnapshot: quantEvidence.quantDetail.featureSnapshot ?? null,
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
    if (this.debatePending(symbol)) {
      console.log(`[ChiefTrader] Refusing to evaluate ${symbol} while an adversarial debate is still in flight.`);
      return;
    }

    eventBus.emit(EVENTS.CHIEF_CONSENSUS_STARTED, { traceId, symbol, ideaCount: this.recentIdeas.filter(i => i.symbol === symbol).length });

    const relevantIdeas = this.recentIdeas.filter(i => i.symbol === symbol);
    const riskExitIdeas = relevantIdeas.filter(i => this.isRiskExit(i));
    const evidence: Evidence[] = await Promise.all(relevantIdeas.map(async i => ({
      ...i,
      confidence: await this.calibrateConfidence(i.agent, i.confidence),
      weight: this.resolveWeight(i.agent),
    })));

    const result = EvidenceAggregator.aggregate(evidence);
    const agentsAgreed = result.agreements.map(e => `${e.agent}(wt:${e.weight.toFixed(2)})`).join(", ");
    const agentsDisagreed = result.disagreements.map(e => `${e.agent}(wt:${e.weight.toFixed(2)})`).join(", ");
    if (result.disagreements.length > 0) {
      eventBus.emit(EVENTS.AGENT_DISAGREEMENT, {
        traceId,
        symbol,
        buyEvidence: evidence.filter(e => e.side === 'BUY').map(e => ({ agent: e.agent, confidence: e.confidence, reasoning: e.reasoning })),
        sellEvidence: evidence.filter(e => e.side === 'SELL').map(e => ({ agent: e.agent, confidence: e.confidence, reasoning: e.reasoning })),
        holdEvidence: evidence.filter(e => e.side === 'HOLD' && e.confidence > 0).map(e => ({ agent: e.agent, confidence: e.confidence, reasoning: e.reasoning })),
        disagreementCount: result.disagreements.length,
        disagreementScore: result.disagreements.length >= 2 ? 'HIGH' : 'MODERATE',
        winningSide: result.side,
        winningConfidence: result.confidence,
      });
    }

    let approved = false;
    let reason = "";
    let approvedSide = result.side;
    let approvedConfidence = result.confidence;
    let approvedPrice = result.currentPrice;
    let approvedEvidence = evidence;
    let approvedAgreed = agentsAgreed;

    if (riskExitIdeas.length > 0) {
      const exitIdea = riskExitIdeas[riskExitIdeas.length - 1];
      approved = true;
      approvedSide = 'SELL';
      approvedConfidence = exitIdea.confidence;
      approvedPrice = exitIdea.currentPrice ?? result.currentPrice;
      reason = `[Risk Exit] ${exitIdea.reasoning}`;
      approvedAgreed = `${RISK_EXIT_AGENT}(wt:${this.resolveWeight(RISK_EXIT_AGENT).toFixed(2)})`;
    } else {
      const uniqueIndependent = new Set(
        result.agreements.filter(e => e.agent !== 'ConsensusDebate').map(e => e.agent)
      );
      const enoughIndependentVoices = uniqueIndependent.size >= MIN_INDEPENDENT_AGREEING_AGENTS;
      const debateSaidHold = evidence.some(e => e.agent === 'ConsensusDebate' && e.side === 'HOLD');
      const bearSaidHold = evidence.some(e => e.agent === bullBearResearchConfig.bearAgentName && e.side === 'HOLD');
      const aiContradicts = evidence.some((e: any) => {
        const review = e.quantDetail?.aiContradictionAnalysis;
        return review?.available === true && review.aiAgreesWithSide === false;
      });

      if (result.side === 'HOLD' || result.confidence <= CONSENSUS_APPROVAL_THRESHOLD) {
        reason = `[NO TRADE] Confidence ${(result.confidence*100).toFixed(1)}% did not clear ${(CONSENSUS_APPROVAL_THRESHOLD*100).toFixed(0)}%.`;
      } else if (!enoughIndependentVoices) {
        reason = `[NO TRADE] Only ${uniqueIndependent.size} independent agent(s) agreed on ${result.side} (need ${MIN_INDEPENDENT_AGREEING_AGENTS}). A single voice is not confirmation.`;
      } else if (debateSaidHold) {
        reason = `[NO TRADE] Adversarial debate verdict was HOLD - the thesis did not survive a search for reasons not to trade.`;
      } else if (bearSaidHold) {
        reason = `[NO TRADE] ${bullBearResearchConfig.bearAgentName} found a high-confidence case against the trade.`;
      } else if (aiContradicts) {
        reason = `[NO TRADE] Quant AI contradiction review disagrees with the deterministic side - thesis challenged, not overwritten.`;
      } else {
        approved = true;
        reason = `[Chief Consensus Approval] Strong agreement. Final Confidence: ${(result.confidence*100).toFixed(1)}%. Agreed: [${agentsAgreed}]. Disagreed: [${agentsDisagreed || 'None'}]. Rationale: ${result.reasoning}`;
      }
    }

    // Unconditional COMPLETED signal (unlike CHIEF_APPROVED_IDEA, which only fires on approval) -
    // lets live animation show the Chief Trader node finishing its evaluation even when the
    // result is "not yet, waiting for more evidence," not just on a successful approval.
    eventBus.emit(EVENTS.CHIEF_CONSENSUS_COMPLETED, { traceId, symbol, approved, confidence: approvedConfidence, side: approvedSide, threshold: CONSENSUS_APPROVAL_THRESHOLD });

    for (const e of approvedEvidence) {
      if (e.side !== 'BUY' && e.side !== 'SELL' && e.side !== 'HOLD') continue;
      recordPitLive({
        kind: e.agent === 'NewsAgent' ? 'NEWS_AGENT' : 'AGENT_REASONING',
        symbol,
        agent: e.agent,
        side: e.side,
        confidence: e.confidence,
        payloadJson: JSON.stringify({ traceId, reasoning: e.reasoning, currentPrice: e.currentPrice }),
        source: 'ChiefTraderAgent',
      });
    }
    recordPitLive({
      kind: 'CHIEF_TRADER',
      symbol,
      agent: 'ChiefTrader',
      side: approved ? approvedSide : 'HOLD',
      confidence: approvedConfidence,
      payloadJson: JSON.stringify({ traceId, approved, reason }),
      source: 'ChiefTraderAgent',
    });

    if (approved) {
       this.recentIdeas = this.recentIdeas.filter(i => i.symbol !== symbol);

       const transactionId = await recordConsensusTransaction({
         symbol,
         side: approvedSide,
         weightedConfidence: approvedConfidence,
         threshold: CONSENSUS_APPROVAL_THRESHOLD,
         approved: true,
         reasoning: reason,
         evidence: approvedEvidence.map(e => ({
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
         side: approvedSide,
         confidence: approvedConfidence,
         currentPrice: approvedPrice,
         reasoning: reason,
         agentsContext: approvedAgreed,
         evidence: approvedEvidence.map(e => ({ agent: e.agent, side: e.side, confidence: e.confidence, weight: e.weight, reasoning: e.reasoning })),
         supportingQuantDetail: this.buildSupportingQuantDetail(approvedEvidence, approvedPrice),
       });

       eventBus.emit(EVENTS.TRADE_LIFECYCLE, { traceId, symbol, state: 'APPROVED', side: approvedSide, reason });

       // Non-blocking, optional independent second opinion (OPENALICE_INTEGRATION_AUDIT.md Phase 3/4).
       // Fire-and-forget: never awaited, never gates this approval or the RiskEngine call that
       // follows it. A no-op when OpenAlice isn't configured (see OpenAliceVerificationService).
       // Its eventual result (which can take minutes) only ever feeds FUTURE decisions.
       const openAliceTrigger = shouldTriggerOpenAliceVerification({
         confidence: approvedConfidence,
         disagreementCount: result.disagreements.length,
       });
       if (openAliceTrigger.shouldVerify && approvedSide !== 'HOLD' && riskExitIdeas.length === 0) {
         openAliceVerificationService.requestVerification({
           traceId,
           symbol,
           side: approvedSide,
           mode: 'TRADE_VERIFICATION',
           argusConfidence: approvedConfidence,
           argusReasoning: reason,
         });
       }
    } else {
       console.log(`[ChiefTrader] NO TRADE on ${symbol}. ${reason || `Current confidence: ${(result.confidence*100).toFixed(1)}%`}`);
       eventBus.emit(EVENTS.DESK_NO_TRADE, { traceId, symbol, side: approvedSide, confidence: approvedConfidence, reason });
       eventBus.emit(EVENTS.TRADE_LIFECYCLE, { traceId, symbol, state: 'NO_TRADE', reason });
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
      if (this.debatePending(symbol)) continue;
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
        reasoning: `No consensus reached before the evaluation window closed. Best side: ${result.side} at ${(result.confidence * 100).toFixed(1)}% (threshold ${(CONSENSUS_APPROVAL_THRESHOLD * 100).toFixed(0)}%). Independent agreeing agents: ${new Set(result.agreements.filter(e => e.agent !== 'ConsensusDebate').map(e => e.agent)).size}.`,
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


