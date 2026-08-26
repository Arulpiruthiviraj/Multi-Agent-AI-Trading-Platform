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
 * (quantSignalAgent.evaluateSymbol / kronosForecastAgent.evaluateOnDemand) — not a new bypass.
 *
 * Independence is structural, not a promise: both on-demand methods take only a symbol string.
 * Neither receives TechnicalAgent's side, confidence, or reasoning, so there is nothing here for
 * them to copy, no score to boost, and no vote to share — each still computes entirely from its
 * own data (real bars/regime for Quant, its own rolling price history + local Chronos for Kronos).
 * Every idea either agent produces still goes through the unchanged TRADE_IDEA_GENERATED ->
 * ChiefTrader -> RiskEngine -> OMS spine like any other. No broker, OMS, or RiskEngine import here.
 * ==========================================================
 */
import { eventBus } from '../core/EventBus';
import { isTelemetryPulsePayload } from '../core/telemetryPulse';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';
import { isPipelineAgentEnabled } from '../core/pipelineAgentGate';
import { tradingSafety } from '../config/tradingSafety';
import { quantSignalAgent } from './QuantSignalAgent';
import { kronosForecastAgent } from './KronosForecastAgent';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';

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
    if (idea.agent !== 'TechnicalAgent') return;
    if (idea.side !== 'BUY' && idea.side !== 'SELL') return;
    if (typeof idea.confidence !== 'number' || idea.confidence < tradingSafety.confluenceCoordinatorConfidenceThreshold) return;
    if (!isLiveIdeaGenerationEnabled()) return;

    const symbol = String(idea.symbol || '').toUpperCase();
    if (!symbol) return;

    const now = Date.now();
    const last = this.lastTriggeredAt.get(symbol) ?? 0;
    if (now - last < tradingSafety.confluenceCoordinatorCooldownMs) return;
    this.lastTriggeredAt.set(symbol, now);

    const triggered: string[] = [];
    const skipped: string[] = [];

    const jobs: Array<Promise<void>> = [];

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
