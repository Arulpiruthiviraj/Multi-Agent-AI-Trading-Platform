/**
 * ==========================================================
 * Module: ConfluenceCoordinator
 *
 * Purpose:
 * Agent Confluence Architecture Audit (2026-08-25). Real DB evidence (2,520 historical consensus
 * decisions) showed 90.3% of attempts never reached ChiefTrader's MIN_INDEPENDENT_AGREEING_AGENTS
 * floor (>=2) — not because confidence was low (many rejected BUYs cleared 80-91%), but because
 * TechnicalAgent (10,626 evidence rows all-time) almost never has a second independent agent
 * evaluate the SAME symbol in the same ~60s freshness window. Its only two real productive
 * partners are QuantEngine (38 co-occurrences) and KronosEngine (39) — both deterministic/local,
 * unlike NewsAgent (3 co-occurrences; real paid-API cost, no existing single-symbol on-demand
 * hook — deliberately NOT wired here, see the NewsAgent note below).
 *
 * This module does NOT change the confidence math, weights, thresholds, or approval gate in
 * ChiefTraderAgent.ts/EvidenceAggregator.ts. It only asks agents that were already going to
 * evaluate that symbol eventually (on their own timer) to do so sooner, using the exact same
 * on-demand entry points manualTradeCoEvaluation.ts already uses for operator CONFIRM BUY/SELL
 * (technicalAgent.evaluateOnDemand / quantSignalAgent.evaluateSymbol /
 * kronosForecastAgent.evaluateOnDemand) — not a new bypass.
 *
 * Independence is structural, not a promise: all three on-demand methods take only a symbol
 * string. None receives the triggering idea's side, confidence, or reasoning, so there is
 * nothing here for them to copy, no score to boost, and no vote to share — each still computes
 * entirely from its own data (real tick/bar history for Technical, real bars/regime for Quant,
 * its own rolling price history + local Chronos for Kronos). Every idea any agent produces still
 * goes through the unchanged TRADE_IDEA_GENERATED -> ChiefTrader -> RiskEngine -> OMS spine like
 * any other. No broker, OMS, or RiskEngine import here.
 *
 * 2026-09-22 (symmetric trigger, CLI runtime forensics targeted follow-up): the 2026-08-25 audit's
 * fix was itself asymmetric by construction — it only ever triggered off a TechnicalAgent idea,
 * because TechnicalAgent was that day's real evidence-starved agent (10,626 rows, only 38/39
 * co-occurrences with Quant/Kronos). Live evidence one month later showed the roles had reversed:
 * KronosEngine now evaluates ~5x more often than TechnicalAgent (3,816 vs 787 in a real 6h
 * window), and because this module's trigger check was hardcoded to `idea.agent ===
 * 'TechnicalAgent'`, a strong Kronos-only signal never pulled in a second independent voice at
 * all — 78.8% of consensus rounds in that window carried only one independent evidence group.
 * TRIGGER_ELIGIBLE_AGENTS generalizes the SAME mechanism (deterministic/local, zero-marginal-cost,
 * matching the principle this file already used to justify Quant+Kronos over paid NewsAgent) to
 * all three agents symmetrically: whichever of the three fires a qualifying signal now fans out to
 * the OTHER two (never itself — evaluateOnDemand-ing the same agent that just produced the
 * triggering idea would be redundant, not independent). The existing per-symbol cooldown Map is
 * reused unchanged and is keyed by symbol, not by (symbol, triggering agent) — so this does not
 * create an evaluation storm: whichever qualifying signal for a symbol arrives first within a
 * cooldown window is the one that fans out, exactly as before, just from a broader eligible set.
 * Fundamental/MacroAgent's existing moderate-confidence-gated fan-out is unchanged in its own
 * logic and was already source-agnostic in intent ("this symbol was worth a look") — it now
 * actually receives that opportunity from all three trigger sources instead of only one.
 * ==========================================================
 */
import { eventBus } from '../core/EventBus';
import { isTelemetryPulsePayload } from '../core/telemetryPulse';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';
import { isPipelineAgentEnabled } from '../core/pipelineAgentGate';
import { tradingSafety } from '../config/tradingSafety';
import { technicalAgent } from './TechnicalAgent';
import { quantSignalAgent } from './QuantSignalAgent';
import { kronosForecastAgent } from './KronosForecastAgent';
import { fundamentalAgent } from './FundamentalAgent';
import { macroAgent } from './MacroAgent';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';
import { recordCandidate } from '../core/recentCandidateRegistry';

/** Deterministic/local, zero-marginal-cost agents eligible to both trigger AND be triggered by
 *  this module — see the 2026-09-22 header note above for why these three and not NewsAgent. */
const TRIGGER_ELIGIBLE_AGENTS = new Set(['TechnicalAgent', 'QuantEngine', 'KronosEngine']);

type TradeIdeaPayload = {
  traceId?: string;
  symbol?: string;
  side?: string;
  confidence?: number;
  agent?: string;
  telemetryPulse?: boolean;
  diagnosticTelemetry?: boolean;
};

export class ConfluenceCoordinator {
  private listening = false;
  private lastTriggeredAt: Map<string, number> = new Map();
  private readonly onTradeIdea = (idea: TradeIdeaPayload) => {
    void this.maybeTrigger(idea);
  };

  start(): void {
    if (this.listening) return;
    eventBus.on('TRADE_IDEA_GENERATED', this.onTradeIdea);
    this.listening = true;
  }

  stop(): void {
    if (!this.listening) return;
    eventBus.off('TRADE_IDEA_GENERATED', this.onTradeIdea);
    this.listening = false;
  }

  isListening(): boolean {
    return this.listening;
  }

  /** Test hook — bypasses the per-symbol cooldown for a deterministic re-trigger in a fresh test. */
  resetCooldownForTests(symbol: string): void {
    this.lastTriggeredAt.delete(symbol.toUpperCase());
  }

  private async maybeTrigger(idea: TradeIdeaPayload): Promise<void> {
    if (!tradingSafety.confluenceCoordinatorEnabled) return;
    if (isTelemetryPulsePayload(idea)) return;
    if (!idea.agent || !TRIGGER_ELIGIBLE_AGENTS.has(idea.agent)) return;
    if (idea.side !== 'BUY' && idea.side !== 'SELL') return;
    if (typeof idea.confidence !== 'number' || idea.confidence < tradingSafety.confluenceCoordinatorConfidenceThreshold) return;
    if (!isLiveIdeaGenerationEnabled()) return;

    const symbol = String(idea.symbol || '').toUpperCase();
    if (!symbol) return;

    const now = Date.now();
    const last = this.lastTriggeredAt.get(symbol) ?? 0;
    if (now - last < tradingSafety.confluenceCoordinatorCooldownMs) return;
    this.lastTriggeredAt.set(symbol, now);
    // Phase 9 (same-candidate convergence): this symbol just cleared the exact same real bar
    // (qualifying TechnicalAgent signal, cooldown respected) ConfluenceCoordinator itself already
    // trusts enough to reactively re-check with QuantEngine/Kronos - record it so Fundamental/
    // MacroAgent's own priority round-robin can prefer it too, when still fresh. Never a vote,
    // never a side/confidence - just "this symbol was worth a look", the same fact this module
    // already acts on for Quant/Kronos.
    recordCandidate(symbol, now);

    const triggered: string[] = [];
    const skipped: string[] = [];

    const jobs: Array<Promise<void>> = [];

    // 2026-09-22: fan out to the OTHER two deterministic/local agents, never back to whichever
    // one produced the triggering idea (that agent will naturally re-evaluate this symbol on its
    // own normal cadence - re-triggering it here would be redundant, not independent evidence).
    if (idea.agent !== 'TechnicalAgent') {
      if (isPipelineAgentEnabled('TechnicalAgent')) {
        triggered.push('TechnicalAgent');
        jobs.push(
          technicalAgent.evaluateOnDemand(symbol).then(
            () => undefined,
            (e: unknown) => {
              console.warn(`[ConfluenceCoordinator] TechnicalAgent on-demand evaluation failed for ${symbol}`, e);
            },
          ),
        );
      } else {
        skipped.push('TechnicalAgent:disabled');
      }
    }

    if (idea.agent !== 'QuantEngine') {
      if (isPipelineAgentEnabled('QuantEngine') && quantSignalAgent.isEnabledPublic()) {
        triggered.push('QuantEngine');
        jobs.push(
          quantSignalAgent.evaluateSymbol(symbol).then(
            () => undefined,
            (e: unknown) => {
              console.warn(`[ConfluenceCoordinator] QuantEngine on-demand evaluation failed for ${symbol}`, e);
            },
          ),
        );
      } else {
        skipped.push('QuantEngine:disabled');
      }
    }

    if (idea.agent !== 'KronosEngine') {
      if (isPipelineAgentEnabled('KronosEngine')) {
        triggered.push('KronosEngine');
        jobs.push(
          kronosForecastAgent.evaluateOnDemand(symbol).then(
            () => undefined,
            (e: unknown) => {
              console.warn(`[ConfluenceCoordinator] KronosEngine on-demand evaluation failed for ${symbol}`, e);
            },
          ),
        );
      } else {
        skipped.push('KronosEngine:disabled');
      }
    }

    // Phase 9 (same-candidate convergence): Fundamental/MacroAgent are wired here too, but gated
    // on a STRICTER confidence bar (moderateMinConfidence, 0.6) than the base 0.5 this function
    // already requires - unlike Quant/Kronos (free, local compute), every on-demand Fundamental/
    // Macro call can spend a real, scarce AlphaVantage request. Reserving them for the stronger
    // half of qualifying signals is the same "spend scarce budget on the best candidates" principle
    // the AlphaVantageBudget reservation logic already applies elsewhere - not a new number, reuses
    // the existing MODERATE-tier confidence floor. evaluateSymbol() itself still fails closed
    // (cached/rate-limited HOLD, never fabricated) if the day's real budget is already spent.
    const highConfidence = typeof idea.confidence === 'number' && idea.confidence >= tradingSafety.moderateMinConfidence;
    if (highConfidence && isPipelineAgentEnabled('FundamentalAgent')) {
      triggered.push('FundamentalAgent');
      jobs.push(
        fundamentalAgent.evaluateSymbol(symbol).catch((e: unknown) => {
          console.warn(`[ConfluenceCoordinator] FundamentalAgent on-demand evaluation failed for ${symbol}`, e);
        }),
      );
    } else {
      skipped.push(highConfidence ? 'FundamentalAgent:disabled' : 'FundamentalAgent:below_moderate_confidence');
    }

    if (highConfidence && isPipelineAgentEnabled('MacroAgent')) {
      triggered.push('MacroAgent');
      jobs.push(
        macroAgent.evaluateSymbol(symbol).catch((e: unknown) => {
          console.warn(`[ConfluenceCoordinator] MacroAgent on-demand evaluation failed for ${symbol}`, e);
        }),
      );
    } else {
      skipped.push(highConfidence ? 'MacroAgent:disabled' : 'MacroAgent:below_moderate_confidence');
    }

    // NewsAgent deliberately excluded: real paid-API cost per call (CLAUDE.md), no existing
    // single-symbol on-demand hook (NewsEngine runs cycle/RSS-cluster based, not per-symbol), and
    // the audit's own data shows it is the rarest, highest-confidence, most independent voice
    // (156 evidence rows all-time) — triggering it reactively off every strong Technical signal
    // would risk burning its budget on symbols it would not have chosen to cover itself.

    if (jobs.length === 0) return;

    observeSafe(() => {
      structuredLogger.info('confluence_coordinator_triggered', {
        category: 'CONSENSUS',
        eventType: 'CONFLUENCE_COORDINATOR_TRIGGERED',
        symbol,
        traceId: idea.traceId,
        decisionId: idea.traceId,
        triggeredAgents: triggered,
        skippedAgents: skipped,
      });
    });

    await Promise.allSettled(jobs);
  }
}

export const confluenceCoordinator = new ConfluenceCoordinator();
