/**
 * InstitutionalStrategyVoteService.ts
 *
 * 2026-10-05: wires the institutional signal strategies to paper-trading verification.
 *
 * Scope: the three single-symbol institutional strategies in StrategyRegistry.INSTITUTIONAL:
 *   - INSTITUTIONAL_VOL_SCALED_MTF_MOMENTUM (AQR-style vol-scaled 20/60d momentum)
 *   - INSTITUTIONAL_TS_MOMENTUM_12M (Moskowitz-Ooi-Pedersen 12-1)
 *   - INSTITUTIONAL_MULTI_FACTOR_MOMENTUM (existing, previously unwired)
 *
 * Each strategy emits AT MOST one independent TRADE_IDEA_GENERATED vote per evaluation,
 * through the same eventBus.emitTradeIdea entry point and the same downstream
 * ChiefTrader -> RiskEngine -> PositionSizing -> OMS -> BrokerManager spine every other
 * agent uses. Never a CHIEF_APPROVED_IDEA, never a placeOrder call from this module.
 * Consensus bar (0.75, min-2-independent-agents), all 25 RiskEngine gates, OMS controls,
 * and PAPER-only operation are untouched - the votes just become additional independent
 * inputs to that unchanged machinery, so paper trading can verify whether the strategies
 * work. Successful paper execution is NOT profitability evidence (house rule).
 *
 * Gating per strategy (all must pass, mirroring JavaQuantAdvisoryService.emitJavaQuantVoteIfEligible):
 *   1. Strategy-specific env flag ON (default false in .env.example - explicit operator
 *      authorization required, never enabled to "see if it works").
 *   2. Per-agent Mission Control toggle (config/pipelineAgents.json).
 *   3. isLiveIdeaGenerationEnabled() campaign-lock composite gate.
 *   4. Java evaluation triggerMet === true (strategy's own entry definition).
 *   5. confidence >= tradingSafety.javaQuantVoteMinConfidence (0.6, shared policy floor).
 *   6. Valid current price.
 *
 * NOT in scope: INSTITUTIONAL_STAT_ARB - pairs need a pair universe and short-selling;
 * its own header documents that as a separate future phase (AlpacaBroker shortSelling=false).
 * It is HTTP-reachable for research but emits no votes.
 *
 * All quant math lives in Java (quant-core-java); this module is a thin vote bridge.
 */

import { isQuantJavaCoreEnabled, tradingSafety } from '../config/tradingSafety';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';
import { isPipelineAgentEnabled } from '../core/pipelineAgentGate';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { resolveIdeaUniverse } from '../core/ideaUniverse';
import { historicalDataGateway } from '../engines/backtest/HistoricalDataGateway';
import { quantCoreBridge } from './QuantCoreBridge';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';
import { eventBus } from '../core/EventBus';
import { generateTraceId } from '../core/traceId';
import { recordMetaLabelFeatures } from '../research/MetaLabelStore';
import { classifyRegime } from '../quant/RegimeEngine';
import { createSingleFlightGuard } from '../core/singleFlightInterval';
import type { ResearchBar } from '../research/ohlcvTypes';

interface InstitutionalStrategySpec {
  strategyId: string;
  agentName: string;
  envVar: string;
  minBars: number;
  lookbackDays: number;
}

// minBars derived from each strategy's own math (not arbitrary round numbers):
// - VolScaledMtfMomentum: slow drift 60d + vol median over 4x20d windows -> 80.
// - TsMomentum12M: formation 252d + skip 21d + vol 60d -> 333.
// - MultiFactorMomentum: longest input horizon 60d + margin -> 80.
const STRATEGIES: InstitutionalStrategySpec[] = [
  {
    strategyId: 'INSTITUTIONAL_VOL_SCALED_MTF_MOMENTUM',
    agentName: 'VolScaledMtfMomentum',
    envVar: 'ARGUS_VOL_SCALED_MTF_MOMENTUM_VOTE_ENABLED',
    minBars: 80,
    lookbackDays: 130,
  },
  {
    strategyId: 'INSTITUTIONAL_TS_MOMENTUM_12M',
    agentName: 'TsMomentum12M',
    envVar: 'ARGUS_TS_MOMENTUM_12M_VOTE_ENABLED',
    minBars: 333,
    lookbackDays: 400,
  },
  {
    strategyId: 'INSTITUTIONAL_MULTI_FACTOR_MOMENTUM',
    agentName: 'MultiFactorMomentum',
    envVar: 'ARGUS_MULTI_FACTOR_MOMENTUM_VOTE_ENABLED',
    minBars: 80,
    lookbackDays: 130,
  },
];

function isStrategyVoteEnabled(spec: InstitutionalStrategySpec): boolean {
  return process.env[spec.envVar] === 'true';
}

export interface InstitutionalVoteResult {
  emitted: boolean;
  reason:
    | 'EMITTED'
    | 'FLAG_OFF'
    | 'AGENT_DISABLED'
    | 'IDEA_GENERATION_GATED'
    | 'TRIGGER_NOT_MET'
    | 'NEUTRAL_SIDE'
    | 'BELOW_MIN_CONFIDENCE'
    | 'INVALID_PRICE'
    | 'JAVA_ERROR';
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

class InstitutionalStrategyVoteService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private cursor = 0;
  private tickGuard = createSingleFlightGuard(() => {});

  start(): void {
    if (this.intervalId || !isQuantJavaCoreEnabled()) return;
    const ms = runtimeIntervals.institutionalStrategyVoteMs;
    this.intervalId = setInterval(() => {
      void this.tickGuard.run(() => this.tick());
    }, ms);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async tick(): Promise<void> {
    if (!isQuantJavaCoreEnabled()) return;
    const active = STRATEGIES.filter(isStrategyVoteEnabled);
    if (active.length === 0) return;
    const universe = resolveIdeaUniverse();
    if (universe.length === 0) return;
    const symbol = universe[this.cursor % universe.length];
    this.cursor += 1;
    for (const spec of active) {
      await this.evaluateStrategy(symbol, spec);
    }
  }

  private async evaluateStrategy(symbol: string, spec: InstitutionalStrategySpec): Promise<void> {
    let bars: ResearchBar[];
    try {
      const endMs = Date.now();
      const startMs = endMs - spec.lookbackDays * 24 * 60 * 60 * 1000;
      await historicalDataGateway.ensureBars(symbol, '1Day', startMs, endMs);
      bars = await historicalDataGateway.getBars(symbol, '1Day', startMs, endMs);
    } catch (e) {
      observeSafe(() => {
        structuredLogger.warn('institutional_strategy_bars_failed', {
          category: 'OBSERVABILITY',
          eventType: 'INSTITUTIONAL_STRATEGY_BARS_FAILED',
          symbol,
          strategyId: spec.strategyId,
          error: e instanceof Error ? e.message : String(e),
        });
      });
      return;
    }
    if (bars.length < spec.minBars) return;

    const result = await quantCoreBridge.fetchResearchStrategy(spec.strategyId, symbol, bars);
    this.emitVoteIfEligible(symbol, spec, result, bars[bars.length - 1].close, bars);
  }

  /** Exported for unit tests - the gating/vote decision without network or timers. */
  emitVoteIfEligible(
    symbol: string,
    spec: InstitutionalStrategySpec,
    evaluation: Record<string, unknown> | null,
    currentPrice: number | null,
    bars?: ResearchBar[],
  ): InstitutionalVoteResult {
    if (!isStrategyVoteEnabled(spec)) return { emitted: false, reason: 'FLAG_OFF' };
    if (!isPipelineAgentEnabled(spec.agentName)) return { emitted: false, reason: 'AGENT_DISABLED' };
    if (!isLiveIdeaGenerationEnabled()) return { emitted: false, reason: 'IDEA_GENERATION_GATED' };
    if (evaluation === null) return { emitted: false, reason: 'JAVA_ERROR' };
    if (evaluation['triggerMet'] !== true) return { emitted: false, reason: 'TRIGGER_NOT_MET' };
    const side = evaluation['side'];

    // 2026-10-05: Meta-label feature capture. Records the feature snapshot for EVERY
    // triggered setup, BEFORE the confidence/price vote gates, so the future meta-model's
    // training set sees the full triggered distribution (avoids selection bias). Fail-closed:
    // recordMetaLabelFeatures logs and never throws. The traceId is generated here and reused
    // for the vote emission below, so features join to agent_predictions.trace_id and from
    // there to predictionOutcomes for labeled training rows. No meta-model is built here.
    const metaTraceId = generateTraceId(symbol);
    try {
      const regimeLabel = (() => {
        try {
          if (!bars || bars.length === 0) return null;
          const r = classifyRegime(bars);
          return typeof r?.regime === 'string' ? r.regime : null;
        } catch { return null; }
      })();
      recordMetaLabelFeatures({
        traceId: metaTraceId,
        strategyId: spec.strategyId,
        symbol,
        signalScore: asFiniteNumber(evaluation['setupScore']),
        signalConfidence: asFiniteNumber(evaluation['confidence']),
        regime: regimeLabel,
        decisionPrice: currentPrice,
        barCount: bars?.length ?? null,
        conditionsMet: Array.isArray(evaluation['conditionsMet']) ? evaluation['conditionsMet'] as string[] : [],
        conditionsFailed: Array.isArray(evaluation['conditionsFailed']) ? evaluation['conditionsFailed'] as string[] : [],
        evidenceSource: 'PAPER',
      });
    } catch { /* recordMetaLabelFeatures is already fail-closed; belt and suspenders */ }

    if (side !== 'BUY' && side !== 'SELL') return { emitted: false, reason: 'NEUTRAL_SIDE' };
    const confidence = asFiniteNumber(evaluation['confidence']);
    if (confidence === null || confidence < tradingSafety.javaQuantVoteMinConfidence) {
      return { emitted: false, reason: 'BELOW_MIN_CONFIDENCE' };
    }
    if (currentPrice == null || !Number.isFinite(currentPrice) || currentPrice <= 0) {
      return { emitted: false, reason: 'INVALID_PRICE' };
    }

    const conditionsMet = Array.isArray(evaluation['conditionsMet']) ? evaluation['conditionsMet'] : [];
    eventBus.emitTradeIdea({
      traceId: metaTraceId, // same traceId as the meta-label feature row recorded above
      symbol,
      side,
      confidence,
      currentPrice,
      reasoning: `[${spec.strategyId}] triggerMet; conditions: ${conditionsMet.join('; ') || 'n/a'}`,
      agent: spec.agentName,
      strategy: spec.strategyId,
      timeframe: 'daily',
    });
    return { emitted: true, reason: 'EMITTED' };
  }
}

export const institutionalStrategyVoteService = new InstitutionalStrategyVoteService();
export { STRATEGIES as INSTITUTIONAL_VOTE_STRATEGIES };
