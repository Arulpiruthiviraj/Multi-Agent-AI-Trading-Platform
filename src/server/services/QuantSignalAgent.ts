/**
 * ==========================================================
 * Module: QuantSignalAgent
 *
 * Purpose:
 * Phase 3 of the additive quant layer - the real agent that wires RegimeEngine.ts/
 * MarketContext.ts into the existing decision pipeline, following the exact same shape
 * TechnicalAgent.ts already uses (a real class, a singleton export, real TRADE_IDEA_GENERATED
 * emission via eventBus.emitTradeIdea with the same {traceId,symbol,side,confidence,reasoning,
 * agent,currentPrice} shape every other agent uses). ChiefTraderAgent.ts already has a weight
 * reserved for `agent:'QuantEngine'` (0.15, unused until now) - no change needed there.
 *
 * Deliberately timer-driven over real ohlcv_bars (HistoricalDataGateway), not tick-driven off
 * MARKET_DATA like TechnicalAgent/AdvancedQuantEngines - those two already disclose in their own
 * comments that they use the latest tick price as O=H=L=C, which is not real OHLC. Real daily
 * bars don't update per-tick anyway, so a periodic pull is the honest cadence for this data.
 *
 * OFF BY DEFAULT: `start()` is a no-op unless QUANT_ENGINE_ENABLED=true, self-contained inside
 * this class (not left to whoever calls start() to remember) - the same env-var convention this
 * codebase already uses for OpenAliceVerificationService (OPENALICE_ENABLED). Anyone who hasn't
 * opted in sees zero behavior change.
 * ==========================================================
 */
import { generateTraceId } from '../core/traceId';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { db } from '../db';
import * as schema from '../db/schema';
import { marketDataWorker, type RescueRequestClass } from './MarketDataWorker';
import { getCachedMoverSymbols } from '../continuous/MarketUniverseScanner';
import { historicalDataGateway, Bar, isDailyBarFinal, expectedBarCountForWindow } from '../engines/backtest/HistoricalDataGateway';
import { getRegisteredHistoricalBarProvider } from '../engines/backtest/historicalBarProvider';
import { classifyRegime, RegimeResult } from '../quant/RegimeEngine';
import { quantCoreBridge } from './QuantCoreBridge';
import { emitJavaCoreEnsembleVoteIfEligible } from './JavaCoreEnsembleVoteService';
import { getMarketContext, MarketContextResult } from '../quant/MarketContext';
import { computeMomentumFeatures } from '../quant/indicators/momentum';
import { computeVolumeFeatures } from '../quant/indicators/volume';
import { computeSupportResistanceFeatures } from '../quant/indicators/supportResistance';
import { computeSmcFeatures } from '../quant/indicators/smc';
import { evaluateAll, bestStrategyIdea, CORE_STRATEGIES } from '../quant/strategies/StrategyEngine';
import { filterQuarantinedStrategies } from '../quant/strategies/StrategyEmissionEligibility';
import { selectWithBoundedExploration } from '../quant/strategies/StrategyExplorationScheduler';
import { resolvePaperTestingOverlay } from '../research/paperTestingOverlay';
import { snapshotFromStrategyContext } from '../quant/QuantitativeFeatureEngine';
import { recordQuantInputEvidence } from '../observability/quantInputProvenance';
import { assembleTradeThesis } from '../quant/thesis/assembleTradeThesis';
import { StrategyContext, StrategyEvaluation } from '../quant/strategies/types';
import { computeGroupedScores, GroupedScores } from '../quant/scoring/GroupedScores';
import { recordCandidate } from '../core/recentCandidateRegistry';
import { analyzeContradictions, ContradictionAnalysisResult, ContradictionAnalysisInput } from '../quant/ai/QuantContradictionAnalyzer';
import { riskRewardRatio, expectedValue, levelsAreDirectionallyConsistent, MIN_SAMPLE_SIZE_FOR_KELLY } from '../quant/risk/ExpectedValue';
import type { RiskRewardResult } from '../quant/risk/ExpectedValue';
import { computeLiveStrategyWinRate } from '../quant/risk/LiveStrategyPerformance';
import { MIN_BARS } from '../quant/RegimeEngine';
import { tradingSafety, isQuantColdStartBootstrapEnabled, isQuantIndependentQualificationEnabled, isStrategySelectionConfluenceGuardEnabled, isQuantPrioritySchedulerEnabled } from '../config/tradingSafety';
import { computeInternalEnsembleQualification, shouldSuppressForConfluenceGuard, resolveEnsembleEvidenceForForecast } from '../quant/internalQuantEnsemble';
import { buildForecast } from '../research/forecastEngine';
import { isRuntimeFlagEnabled, resolveRuntimeNumber } from '../config/effectiveRuntimeConfig';
import { deskIntelligence, rankEvaluationsForRegime, newsAgentEmitsTradeIdeas } from '../config/deskIntelligence';
import { filterEvaluationsForStrategyFocus, normalizeStrategyFocus, selectEvaluationsForAdaptiveRegime } from '../config/strategyFocus';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';
import { isPipelineAgentEnabled } from '../core/pipelineAgentGate';
import { notePipelineAgentFailure, notePipelineAgentGated, notePipelineAgentSuccess, notePipelineAgentTick } from '../core/pipelineAgentHealth';
import { assessDataQuality } from '../core/dataQuality';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';
import { getNewsCatalysts, hasRealCatalystEvidence } from './NewsCatalystStore';
import { buildEliteTraderDecision } from '../desk/EliteTraderDecision';
import { isMultiAssetEnabled } from '../config/multiAsset';
import { classifyAsset } from '../multiAsset/AssetClassifier';
import { createSingleFlightGuard } from '../core/singleFlightInterval';
// 2026-10-09 (P2 scheduler mission, Task C): bounded priority quant scheduler. Control-plane
// only - evaluateSymbol()'s signature and behavior contract are unchanged; the scheduler calls
// it as a black box. Feature-flagged (QUANT_PRIORITY_SCHEDULER_ENABLED, default off): the
// legacy runCycle fan-out below is byte-for-byte unchanged when the flag is off.
import {
  initQuantPriorityScheduler,
  getQuantPriorityScheduler,
  runQuantSchedulerBatch,
  resolveQuantSchedulerConfig,
  QuantCandidatePriority,
  type QuantPriorityScheduler,
} from '../scheduling/quantPriorityScheduler';
import { isExperimentalStrategyLive } from '../config/quantExperimentalStrategies';
import { getTradingDateStr, tradingWallTimeToIso, TRADING_TIMEZONE } from '../core/TradingCalendar';
import { replaySafety } from '../replay/replaySafety';
// 2026-10-09 (certification mission item 1 - OCT9_PIT_PROVENANCE_ESCAPE): per-decision
// point-in-time replay provenance emission on the real decision path. The wrapper is
// synchronous, never throws, and never awaits — provenance is telemetry, never a gate.
import { recordDecisionProvenance, buildBarEvidence } from '../replay/provenance/decisionProvenance';

const DEFAULT_CYCLE_INTERVAL_MS = tradingSafety.quantCycleIntervalMs;
const LOOKBACK_DAYS = tradingSafety.quantLookbackDays;
const TIMEFRAME = '1Day';
/** 2026-09-29 (intraday-bars-for-opening-range fix): a real second granularity, fetched ONLY when
 *  OPENING_RANGE_BREAKOUT is live (isExperimentalStrategyLive gate below) - every other CORE/
 *  experimental strategy keeps consuming TIMEFRAME ('1Day') bars unchanged. Never applied
 *  "indiscriminately" to swing strategies. */
const INTRADAY_TIMEFRAME = '1Min';
const MIN_BARS_TO_EVALUATE = MIN_BARS;

// Kept for unit tests of the historical regime mapping. Live evaluateSymbol must NOT emit this
// as a trade idea — no EV, stop, or target.
const MIN_REGIME_CONFIDENCE_TO_TRADE = tradingSafety.minRegimeConfidenceToTrade;

/**
 * P1-1 (2026-10-04 remediation): the last '1Day' bar may still be forming (fetched intraday,
 * marked provisional in ohlcv_bars - see HistoricalDataGateway.persistBars()). Its close is then a
 * frozen early-session snapshot, not today's real current price. Prefer the live tick whenever the
 * last bar's own trading day has not closed yet - falls back to the bar close only when no live
 * quote is available at all, never silently losing the bar-based evaluation this agent exists for.
 * Extracted as a pure function (same pattern as IbkrSocketSession.buildIbkrOrder /
 * InteractiveBrokersWebApiAdapter.resolveIbkrWebOrderType) so this safety-relevant price selection
 * is directly unit-testable without the full evaluateSymbol pipeline.
 */
export function resolveQuantCurrentPrice(lastBar: Bar, liveQuote: number | null, nowMs: number): number {
  const lastBarIsFinal = isDailyBarFinal(lastBar.timestamp, nowMs, TRADING_TIMEZONE);
  return (!lastBarIsFinal && liveQuote != null && Number.isFinite(liveQuote) && liveQuote > 0) ? liveQuote : lastBar.close;
}

export interface DerivedIdea {
  side: 'BUY' | 'SELL';
  confidence: number; // 0-1, same scale every other TRADE_IDEA_GENERATED emitter uses
  reasoning: string;
}

/**
 * H2 (2026-10-09, Phase 3 certification): the evaluateSymbol() result shape, shared by the public
 * observability wrapper and the private evaluation body so the two signatures cannot drift apart.
 */
export type QuantSymbolEvaluation = {
  regime: RegimeResult;
  marketContext: MarketContextResult;
  strategyEvaluations: StrategyEvaluation[];
  groupedScores: { BUY: GroupedScores; SELL: GroupedScores };
  aiContradictionAnalysis: ContradictionAnalysisResult | null;
} | null;

/**
 * 2026-09-29 (intraday-bars-for-opening-range fix): pure window math, extracted from
 * evaluateSymbol() so it's directly unit-testable without mocking historicalDataGateway. Bounded to
 * today's real regular session (America/New_York, DST-correct via TradingCalendar.ts) - never more
 * than 8h back, never before session open, never after `nowMs`. Returns null when there is no real
 * window to fetch (session open is at/after `nowMs`, e.g. called before the market has opened
 * today) - the caller must never fetch a zero/negative-width window.
 */
export function computeIntradayFetchWindow(nowMs: number): { startMs: number; endMs: number; sessionOpenMs: number } | null {
  const startMinutes = replaySafety.regularSessionStartMinutes;
  const sessionOpenHHMM = `${String(Math.floor(startMinutes / 60)).padStart(2, '0')}:${String(startMinutes % 60).padStart(2, '0')}`;
  const sessionOpenMs = Date.parse(tradingWallTimeToIso(getTradingDateStr(new Date(nowMs)), sessionOpenHHMM));
  const startMs = Math.max(sessionOpenMs, nowMs - 8 * 60 * 60 * 1000);
  if (startMs >= nowMs) return null;
  return { startMs, endMs: nowMs, sessionOpenMs };
}

export function deriveIdeaFromRegime(regime: RegimeResult): DerivedIdea | null {
  if (regime.insufficientData || regime.confidence < MIN_REGIME_CONFIDENCE_TO_TRADE) return null;
  if (regime.regime === 'BULLISH_TREND') {
    return {
      side: 'BUY',
      confidence: regime.confidence,
      reasoning: `QuantEngine: BULLISH_TREND regime (trendStrength ${regime.trendStrength}, marketStructure ${regime.marketStructure}, volatility ${regime.volatility}), confidence ${regime.confidence.toFixed(2)} from real multi-feature agreement.`,
    };
  }
  if (regime.regime === 'BEARISH_TREND') {
    return {
      side: 'SELL',
      confidence: regime.confidence,
      reasoning: `QuantEngine: BEARISH_TREND regime (trendStrength ${regime.trendStrength}, marketStructure ${regime.marketStructure}, volatility ${regime.volatility}), confidence ${regime.confidence.toFixed(2)} from real multi-feature agreement.`,
    };
  }
  return null; // SIDEWAYS_RANGE - no directional idea
}

/**
 * EV-gate R:R computation (2026-10-07, strategy-layer audit D3) - the exact decision this
 * agent's EV gate makes about a strategy's stop/target before computing expected value.
 * riskRewardRatio() is direction-agnostic (measures |distances| only), so a strategy bug
 * emitting an inverted stop/target pair (e.g. a BUY whose "stop" sits above the entry) would
 * still yield a positive "valid" ratio and sail through the EV gate. levelsAreDirectionallyConsistent()
 * closes that hole: inconsistent levels return null here, which routes the idea to the
 * EXPECTED_VALUE_UNCOMPUTABLE refusal path - a strategy-data defect, never a real R:R.
 * Extracted as a pure, separately-testable function (same pattern as
 * deriveColdStartBootstrapIdea below): crafting real market bars that make a real strategy
 * emit an inverted stop/target through the full evaluateSymbol() pipeline is impractical for
 * a focused regression test, but the gate's decision logic must still be pinned.
 */
export function computeEvGateRiskReward(
  side: 'BUY' | 'SELL',
  entry: number,
  stopPrice: number | null,
  targetPrice: number | null,
): RiskRewardResult | null {
  if (stopPrice === null || targetPrice === null) return null;
  if (!levelsAreDirectionallyConsistent(side, entry, stopPrice, targetPrice)) return null;
  return riskRewardRatio(entry, stopPrice, targetPrice);
}

/**
 * Provider-D4 (2026-10-07, strategy-layer audit): QuantSignalAgent used to `await
 * analyzeContradictions()` in-cycle before TRADE_IDEA_GENERATED emission - a hung generative-AI
 * provider added its full (failure-neutral, worst-case ~aiProviderTimeoutMs x N providers,
 * sequential) latency to every real idea's decision path, violating quant-first: AI is advisory
 * and must never sit on the critical path. The review's own result can never change an idea's
 * side/confidence, and it already degrades honestly to available:false when no AI provider is
 * configured - so the wait is now bounded by tradingSafety.quantContradictionMaxWaitMs, a
 * LATENCY BOUND, not a trading threshold. On timeout the emission proceeds with the same
 * honest-degradation available:false shape; the timed-out review is left to settle on its own
 * (never an unhandled rejection) and its late result is discarded, never retro-applied.
 * The `analyze`/`maxWaitMs` overrides exist for unit tests only - production always passes the
 * real analyzer and the config value.
 */
export async function analyzeContradictionsBounded(
  input: ContradictionAnalysisInput,
  traceId: string,
  analyze: (input: ContradictionAnalysisInput, traceId: string) => Promise<ContradictionAnalysisResult> = analyzeContradictions,
  maxWaitMs: number = tradingSafety.quantContradictionMaxWaitMs,
): Promise<ContradictionAnalysisResult> {
  const unavailable = (reason: string): ContradictionAnalysisResult => ({
    available: false,
    aiAgreesWithSide: null,
    additionalContradictions: [],
    scenarioAnalysis: '',
    disagreementNote: null,
    reason,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      // analyzeContradictions() already catches internally, but a substituted analyzer (or a
      // future refactor) must never turn this race into an unhandled rejection.
      analyze(input, traceId).catch((e) => unavailable(`AI contradiction analysis failed: ${e?.message ?? e}`)),
      new Promise<ContradictionAnalysisResult>((resolve) => {
        timer = setTimeout(() => resolve(unavailable(
          `AI contradiction review exceeded the ${maxWaitMs}ms latency bound (quantContradictionMaxWaitMs) - proceeding without it; the review is advisory-only and cannot change the deterministic side/confidence.`,
        )), maxWaitMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Real bug found and fixed (Phase 12, 2026-08-31 zero-emission discrepancy investigation):
 * deriveIdeaFromRegime() alone structurally can never bootstrap a mean-reversion-family CORE
 * strategy (RANGE_REVERSION/MEAN_REVERSION) - it returns null unconditionally for SIDEWAYS_RANGE,
 * which is the ONLY regime those two strategies are ever the regime-preferred winner in. Exact
 * replay of the real selection code (rankEvaluationsForRegime/selectEvaluationsForAdaptiveRegime/
 * bestStrategyIdea) against real historical quant_assessments rows proved RANGE_REVERSION would
 * have won real strategy selection ~2,742 times (confidence up to 0.944), 100% of them during
 * SIDEWAYS_RANGE - a total, structural deadlock, not bad luck or a bad strategy.
 *
 * This function is the exact fallback chain QuantSignalAgent.evaluateSymbol() now uses: try the
 * regime-only derivation first (unchanged behavior for BULLISH_TREND/BEARISH_TREND); if that
 * yields nothing, fall back to the strategy's own already-computed side/confidence - real,
 * validated output from bestStrategyIdea() (which already cleared MIN_STRATEGY_CONFIDENCE_TO_TRADE),
 * never fabricated. Extracted as a small, pure, separately-testable function rather than left
 * inline, since crafting real market bars that trigger a specific strategy's exact multi-condition
 * entry through the full evaluateSymbol() pipeline is impractical for a focused regression test.
 */
export function deriveColdStartBootstrapIdea(
  regime: RegimeResult,
  strategyName: string,
  strategySide: 'BUY' | 'SELL',
  strategyConfidence: number,
): DerivedIdea | null {
  const regimeIdea = deriveIdeaFromRegime(regime);
  if (regimeIdea) return regimeIdea;
  return {
    side: strategySide,
    confidence: strategyConfidence,
    reasoning: `QuantEngine: no directional regime signal for ${regime.regime} - falling back to ${strategyName}'s own real setup (side ${strategySide}, confidence ${strategyConfidence.toFixed(2)}) instead of discarding it.`,
  };
}

/**
 * 2026-10-10 (Part 21 selection-pool explainability): bounded, pure breakdown of the
 * quant selection chain for NO_ELIGIBLE_STRATEGY diagnostics. Trigger != eligibility:
 * a strategy can triggerMet and still be excluded by the focus filter, the adaptive
 * regime filter, the quarantine filter, or the EV/R:R economics gate. Each exclusion
 * stage is named explicitly so the next SNOW-style "triggered but never emitted" case
 * is answerable from persisted DESK_NO_TRADE evidence instead of a forensic
 * reconstruction. Bounded by construction: strategy-ID lists only (<=21 entries each).
 */
export interface SelectionPoolBreakdown {
  evaluated: string[];
  triggered: string[];
  excludedByFocus: string[];
  excludedByAdaptiveRegime: string[];
  excludedByQuarantine: string[];
  economicsRefusal: string | null;
  remaining: string[];
}

export function buildSelectionPoolBreakdown(args: {
  strategyEvaluations: Array<{ strategy: string; triggerMet: boolean }>;
  focusedEvaluations: Array<{ strategy: string }>;
  adaptedEvaluations: Array<{ strategy: string }>;
  emissionEligibleEvaluations: Array<{ strategy: string }>;
  economicsRefusal: string | null;
}): SelectionPoolBreakdown {
  const idsOf = (evals: Array<{ strategy: string }>): string[] => evals.map(e => e.strategy);
  const notIn = (all: string[], kept: string[]): string[] => all.filter(s => !kept.includes(s));
  const evaluated = idsOf(args.strategyEvaluations);
  const focused = idsOf(args.focusedEvaluations);
  const adapted = idsOf(args.adaptedEvaluations);
  const emissionEligible = idsOf(args.emissionEligibleEvaluations);
  return {
    evaluated,
    triggered: args.strategyEvaluations.filter(e => e.triggerMet).map(e => e.strategy),
    excludedByFocus: notIn(evaluated, focused),
    excludedByAdaptiveRegime: notIn(focused, adapted),
    excludedByQuarantine: notIn(adapted, emissionEligible),
    economicsRefusal: args.economicsRefusal,
    remaining: emissionEligible,
  };
}

export class QuantSignalAgent {
  private intervalId: NodeJS.Timeout | null = null;
  // Batch 2 timer/reentrancy sweep (2026-09-23): runCycle() fans out per-symbol evaluation across
  // the active universe (bounded concurrency via symbolConcurrency()), including real historical
  // bar fetches subject to a documented Alpaca 429 backoff path - i.e. it can legitimately run long
  // under rate-limiting. A cycle outlasting cycleMs would otherwise let a second overlapping
  // runCycle() storm the same rate-limited API and double-evaluate symbols concurrently. Pure
  // addition: coalesces (skips), never queues; downstream duplicate-signal/cooldown gates were
  // already the real safety net for any idea this could double-emit - this only removes wasted work.
  private cycleGuard = createSingleFlightGuard((e) => console.error('[QuantSignalAgent] Cycle failed', e));

  private isEnabled(): boolean {
    return isRuntimeFlagEnabled('QUANT_ENGINE_ENABLED');
  }

  /** Public read for manual co-eval / health — does not start the cycle. */
  isEnabledPublic(): boolean {
    return this.isEnabled();
  }

  private cycleIntervalMs(): number {
    return resolveRuntimeNumber('QUANT_ENGINE_INTERVAL_MS', DEFAULT_CYCLE_INTERVAL_MS);
  }

  start(): void {
    if (!this.isEnabled()) {
      console.log('[QuantSignalAgent] QUANT_ENGINE_ENABLED is not "true" - not starting. Set it in .env or Settings (restart required) to enable the additive quant decision layer.');
      return;
    }
    if (this.intervalId) return;
    const cycleMs = this.cycleIntervalMs();
    // 2026-10-09 (P2 scheduler, Task C): opt-in bounded priority scheduling. Default off -
    // zero behavior change unless the operator explicitly sets QUANT_PRIORITY_SCHEDULER_ENABLED.
    if (isQuantPrioritySchedulerEnabled()) {
      this.initPriorityScheduler();
      console.log('[QuantSignalAgent] QUANT_PRIORITY_SCHEDULER_ENABLED=true - runCycle admits its universe to the bounded priority scheduler (P0 urgent mover / P1 promoted / P2 normal / P3 background) instead of the legacy snapshot fan-out.');
    }
    console.log(`[QuantSignalAgent] Starting - real regime/market-context evaluation every ${cycleMs / 1000}s for actively-tracked symbols.`);
    void this.cycleGuard.run(() => this.runCycle());
    this.intervalId = setInterval(() => {
      void this.cycleGuard.run(() => this.runCycle());
    }, cycleMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    // 2026-10-09 (P2 scheduler, Task C): stopping the agent retires the scheduler too -
    // in-flight candidates settle to explicit terminals (never silently dropped) and the
    // sweeper stops. A later start() builds a fresh scheduler via initPriorityScheduler().
    try {
      getQuantPriorityScheduler()?.stop();
    } catch {
      /* scheduler shutdown must never break agent stop */
    }
  }

  /**
   * 2026-10-09 (P2 scheduler, Task C): wires the bounded priority scheduler's
   * dependencies. evaluateSymbol stays the black-box evaluation entry point - its
   * signature and behavior contract are unchanged (the task's explicit constraint).
   * Called from start() when the feature flag is on, and lazily from runCycle as a
   * defensive fallback.
   */
  private initPriorityScheduler(): void {
    initQuantPriorityScheduler({
      evaluateSymbol: (symbol, options) => this.evaluateSymbol(symbol, options),
      getBars: (s, tf, sMs, eMs) => historicalDataGateway.getBars(s, tf, sMs, eMs),
      ensureBars: (s, tf, sMs, eMs) => historicalDataGateway.ensureBars(s, tf, sMs, eMs),
      providerRateLimitedUntilMs: () => historicalDataGateway.getBarsRateLimitedUntilMs(),
      minBars: MIN_BARS_TO_EVALUATE,
      expectedBarCount: (tf, sMs, eMs) => expectedBarCountForWindow(tf, sMs, eMs),
      lookbackDays: LOOKBACK_DAYS,
      timeframe: TIMEFRAME,
    });
  }

  /**
   * 2026-10-10 (defect hunt, Lead 5 split-brain fix): retires the priority
   * scheduler singleton so the legacy sequential fan-out is the ONLY active
   * evaluation path. stop() terminally transitions every tracked candidate to
   * EVICTED/SCHEDULER_STOPPED (explicit, never silent) and late-settling
   * evaluateSymbol() continuations are discarded by the scheduler's own
   * exactly-once terminal guard - no duplicate transitions, no stuck symbols.
   * Called when the feature flag is off (it may have been on for an earlier
   * cycle) and when the scheduler path fails mid-cycle before falling back to
   * the legacy fan-out. Idempotent; a no-op when the scheduler was never
   * created or is already stopped; never throws into the cycle.
   */
  private retirePriorityScheduler(reason: string): void {
    const scheduler = getQuantPriorityScheduler();
    if (!scheduler || scheduler.isStopped()) return;
    try {
      scheduler.stop();
      console.log(`[QuantSignalAgent] Priority scheduler retired (${reason}) - in-flight candidates evicted to explicit terminals; the legacy fan-out is now the only evaluation path.`);
    } catch {
      /* scheduler shutdown must never break the cycle */
    }
  }

  /** Synthetic Market Session Simulator (2026-09-14 mandate, Phase 7): a manual trigger for the
   *  SAME real runCycle() the timer calls - timer-driven agents have no clock injection, so a
   *  simulator running on an accelerated synthetic clock cannot wait on a real setInterval. This
   *  is not a parallel decision path; it is the existing private cycle, exposed for an explicit
   *  caller, exactly the way PredictionOutcomeEvaluator.evaluatePending() already is both
   *  timer-driven and directly callable. */
  async triggerNow(): Promise<void> {
    // Deliberately NOT routed through cycleGuard: this is the simulator harness's explicit
    // "give exit/entry logic a real chance to fire on an accelerated synthetic clock" entry point
    // (see this method's own doc comment above) - coalescing it away under a real timer tick would
    // silently break that guarantee. The timer path above is the one this guard exists to protect.
    await this.runCycle();
  }

  private symbolConcurrency(): number {
    const n = tradingSafety.quantMaxConcurrentSymbols;
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(32, Math.floor(n));
  }

  // Control-plane fairness only: resume with symbols not reached before provider backoff.
  // No strategy score, confidence, subscription cap or provider pacing is changed.
  private nextCycleSymbol: string | null = null;

  private async runCycle(): Promise<void> {
    // H1 (2026-10-09, Phase 3 certification): per-cycle observability. cycleId correlates the
    // STARTED/COMPLETED pair and every per-symbol STARTED/FINISHED event below; scheduledAtMs is
    // captured at cycle entry (the timer's intended fire time, before universe assembly). Additive
    // logging only - no scheduling, ordering, or evaluation behavior changes.
    const cycleId = generateTraceId('quant-cycle');
    const scheduledAtMs = Date.now();
    const active = marketDataWorker.getActiveSymbols();
    // Prefer liquid names that Quant needs most often — still only evaluates subscribed symbols.
    const priority = ['SPY', 'QQQ', 'NVDA', 'HOOD', 'COIN', 'AMD', 'RIOT', 'AAPL', 'MSFT', 'META'];
    const ordered = [
      ...priority.filter((s) => active.includes(s) || active.includes(s.toUpperCase())),
      ...active.filter((s) => !priority.includes(s.toUpperCase()) && !priority.includes(s)),
    ].map((s) => s.toUpperCase()).filter((s, i, arr) => arr.indexOf(s) === i);
    const resumeAt = this.nextCycleSymbol ? Math.max(0, ordered.indexOf(this.nextCycleSymbol)) : 0;
    const symbols = [...ordered.slice(resumeAt), ...ordered.slice(0, resumeAt)];
    const cycleStarted = Date.now();

    if (symbols.length === 0) {
      console.log('[QuantSignalAgent] No actively-tracked symbols yet (MarketDataWorker has no subscriptions) - nothing to evaluate this cycle.');
      notePipelineAgentGated('QuantEngine');
      return;
    }
    const concurrency = Math.min(this.symbolConcurrency(), symbols.length);
    // H1 continued: emitted after the empty-universe guard so every QUANT_CYCLE_STARTED is
    // eventually followed by a QUANT_CYCLE_COMPLETED with the same cycleId (the empty case keeps
    // its existing console.log-only behavior and never starts a cycle).
    observeSafe(() => structuredLogger.info('quant_cycle_started', {
      category: 'DISCOVERY', eventType: 'QUANT_CYCLE_STARTED',
      cycleId, scheduledAtMs, universeSize: symbols.length, concurrency,
      scheduledSymbols: symbols, resumeSymbol: this.nextCycleSymbol,
      providerId: getRegisteredHistoricalBarProvider()?.id ?? null,
    }));
    // 2026-10-09 (P2 scheduler, Task C): feature-flagged scheduler path. Flag off (the
    // default) keeps the legacy snapshot+worker-pool fan-out below byte-for-byte - every
    // existing scheduler test exercises that path. Flag on: the cycle's universe is
    // admitted to the bounded priority scheduler (priority affects WHEN each symbol is
    // evaluated, never any gate outcome) and the same QUANT_CYCLE_STARTED ->
    // QUANT_CYCLE_COMPLETED pair is emitted. Fail-closed: any failure in the scheduler
    // path falls back to the legacy fan-out rather than skipping the cycle.
    if (isQuantPrioritySchedulerEnabled()) {
      try {
        if (!getQuantPriorityScheduler()) this.initPriorityScheduler();
        const scheduler = getQuantPriorityScheduler();
        if (scheduler) {
          await this.runCycleViaScheduler(scheduler, symbols, { cycleId, scheduledAtMs, cycleStarted });
          return;
        }
        console.error('[QuantSignalAgent] Priority scheduler unavailable after init - falling back to legacy fan-out.');
      } catch (e) {
        console.error('[QuantSignalAgent] Priority scheduler path failed - falling back to legacy fan-out', e);
        // 2026-10-10 (defect hunt, Lead 5 split-brain fix): the scheduler path may have
        // admitted candidates BEFORE failing - retire the scheduler so the legacy
        // fan-out below is the only active evaluation path for these symbols. Without
        // this, the scheduler's in-flight evaluateSymbol() calls run concurrently with
        // the legacy fan-out on the same symbols (the scheduler's singleflight dedup
        // only coordinates within itself; the legacy path never consults it).
        this.retirePriorityScheduler('scheduler-path-failed');
      }
    } else {
      // 2026-10-10 (defect hunt, Lead 5 split-brain fix): the flag may have been on for
      // an earlier cycle (a scheduler from that cycle can still hold in-flight
      // evaluations - runQuantSchedulerBatch's bounded wait leaves them tracked) and
      // off now. Retire it before the legacy fan-out so both paths never evaluate the
      // same symbol concurrently. Idempotent and a no-op when the scheduler was never
      // created or is already stopped.
      this.retirePriorityScheduler('flag-off');
    }
    let nextIndex = 0;
    let abortRateLimit = false;
    let anySuccess = false;
    const attemptedSymbols: string[] = [];
    const completedSymbols: string[] = [];
    const workers = Array.from({ length: concurrency }, async () => {
      while (!abortRateLimit) {
        const i = nextIndex++;
        if (i >= symbols.length) return;
        const symbol = symbols[i];
        attemptedSymbols.push(symbol);
        const attemptStarted = Date.now();
        let outcome = 'ERROR';
        observeSafe(() => structuredLogger.info('quant_symbol_evaluation_started', {
          category: 'DISCOVERY', eventType: 'QUANT_SYMBOL_EVALUATION_STARTED', cycleId, symbol,
        }));
        try {
          // H2: cycle context (cycleId + position in the universe snapshot) rides along so the
          // per-symbol STARTED/FINISHED events can be joined back to this cycle. No behavior
          // change - evaluateSymbol treats cycleCtx as opaque correlation metadata.
          const result = await this.evaluateSymbol(symbol, { cycleCtx: { cycleId, scheduledIndex: i } });
          outcome = result ? 'ASSESSED' : 'NO_ASSESSMENT';
          if (result) { anySuccess = true; completedSymbols.push(symbol); }
        } catch (e: any) {
          notePipelineAgentFailure('QuantEngine', e);
          console.error(`[QuantSignalAgent] Failed to evaluate ${symbol}`, e.message);
          // Shared Alpaca 429 backoff is armed inside HistoricalDataGateway — stop fan-out so
          // remaining symbols do not storm the API. Fail closed: no fabricated bars/ideas.
          if (/429|rate-limited|Too Many Requests/i.test(String(e?.message || ''))) {
            // IBKR hist path does not use Alpaca REST — do not abort the whole cycle on Alpaca 429 wording.
            if (getRegisteredHistoricalBarProvider()?.id === 'ibkr_gateway') {
              console.warn(`[QuantSignalAgent] Rate-limit-like error with IBKR hist provider — continuing other symbols (cache/IBKR).`);
              continue;
            }
            abortRateLimit = true;
            console.warn(`[QuantSignalAgent] Alpaca rate limit — aborting remainder of quant cycle (${symbols.length} symbols, concurrency=${concurrency}). Remaining symbols may still use SQLite cache next cycle.`);
            return;
          }
        } finally {
          observeSafe(() => structuredLogger.info('quant_symbol_evaluation_finished', {
            category: 'DISCOVERY', eventType: 'QUANT_SYMBOL_EVALUATION_FINISHED', cycleId, symbol,
            durationMs: Date.now() - attemptStarted, outcome,
          }));
        }
      }
    });
    await Promise.all(workers);
    const notAttemptedSymbols = symbols.slice(attemptedSymbols.length);
    this.nextCycleSymbol = notAttemptedSymbols[0] ?? null;
    observeSafe(() => structuredLogger.info('quant_cycle_completed', {
      category: 'DISCOVERY', eventType: 'QUANT_CYCLE_COMPLETED',
      cycleId, durationMs: Date.now() - cycleStarted, concurrency, attemptedSymbols, completedSymbols,
      notAttemptedSymbols, reason: abortRateLimit ? 'PROVIDER_BACKOFF' : 'COMPLETED',
    }));
    if (anySuccess) {
      notePipelineAgentSuccess('QuantEngine');
    } else if (abortRateLimit) {
      notePipelineAgentGated('QuantEngine');
    }
  }

  /**
   * 2026-10-09 (P2 scheduler, Task C): the feature-flagged scheduler path for runCycle.
   * Admits the cycle's universe to the bounded priority scheduler and awaits every
   * candidate's terminal state (bounded by quantSchedulerMaxBatchWaitMs). Priority
   * affects WHEN each symbol is evaluated, never any gate outcome - evaluateSymbol()
   * itself is unchanged. Emits the same QUANT_CYCLE_COMPLETED vocabulary as the legacy
   * path (plus terminalStateCounts and a scheduler:'priority' marker) so the H1
   * STARTED -> COMPLETED observability invariant holds on both paths.
   */
  private async runCycleViaScheduler(
    scheduler: QuantPriorityScheduler,
    symbols: string[],
    ctx: { cycleId: string; scheduledAtMs: number; cycleStarted: number },
  ): Promise<void> {
    // P0 for real market movers (urgent), P2 for the normal active universe. P1 is for
    // externally-promoted dynamic candidates (discovery/fast-lane admissions via the
    // scheduler's admit API), P3 for background refresh - neither originates here.
    const movers = new Set(getCachedMoverSymbols().map((s) => s.toUpperCase()));
    const summary = await runQuantSchedulerBatch(scheduler, symbols, {
      cycleId: ctx.cycleId,
      priorityOf: (symbol) =>
        movers.has(symbol.toUpperCase())
          ? QuantCandidatePriority.P0_URGENT_MOVER
          : QuantCandidatePriority.P2_NORMAL,
      source: 'CYCLE',
      emitIdeas: true,
    });
    // Fairness pointer, same spirit as the legacy path's resume logic: a symbol still
    // without a terminal state after the bounded batch wait stays tracked by the
    // scheduler, and next cycle's re-admission dedups onto it via singleflight.
    this.nextCycleSymbol = summary.notAttemptedSymbols[0] ?? null;
    const schedulerConfig = resolveQuantSchedulerConfig();
    observeSafe(() => structuredLogger.info('quant_cycle_completed', {
      category: 'DISCOVERY', eventType: 'QUANT_CYCLE_COMPLETED',
      cycleId: ctx.cycleId, durationMs: Date.now() - ctx.cycleStarted,
      concurrency: schedulerConfig.quantWorkerPoolSize,
      attemptedSymbols: summary.attemptedSymbols,
      completedSymbols: summary.completedSymbols,
      notAttemptedSymbols: summary.notAttemptedSymbols,
      externallyDedupedSymbols: summary.externallyDedupedSymbols,
      reason: summary.reason,
      terminalStateCounts: summary.terminalStateCounts,
      scheduler: 'priority',
    }));
    if (summary.completedSymbols.length > 0) {
      notePipelineAgentSuccess('QuantEngine');
    } else if (summary.reason === 'BATCH_WAIT_EXCEEDED') {
      notePipelineAgentGated('QuantEngine');
    }
  }

  /**
   * Evaluate one symbol through the real strategy pipeline and, when a qualifying idea is found,
   * emit it as a QuantEngine trade idea (the normal live path).
   *
   * 2026-10-08 (fast-lane D1 fix): `options.emitIdeas === false` makes this a pure EVALUATION -
   * no QuantEngine emitTradeIdea, no JavaCoreEnsemble vote, no DESK_NO_TRADE held-idea event.
   * Research consumers (e.g. the Fast Opportunity Lane evaluator, whose phase boundary is
   * "deliberately NOT wired to emitTradeIdea/ChiefTrader in this phase") use this so reusing
   * the production evaluation logic can never produce a spine-routed idea one call-frame deeper
   * than the caller intended. Default (undefined) preserves the existing live behavior exactly.
   */
  async evaluateSymbol(symbol: string, options?: { emitIdeas?: boolean; cycleCtx?: { cycleId: string; scheduledIndex: number } }): Promise<QuantSymbolEvaluation> {
    // H2 (2026-10-09, Phase 3 certification): observability wrapper. Emits QUANT_SYMBOL_EVAL_STARTED
    // on entry and QUANT_SYMBOL_EVAL_FINISHED on EVERY exit path (normal, insufficient-bars, thrown
    // error) so a per-symbol evaluation can never again vanish without a trace. cycleCtx is opaque
    // correlation metadata supplied by runCycle; on-demand callers (ConfluenceCoordinator, manual
    // CONFIRM, fast lane) omit it and the events honestly carry null cycleId/scheduledIndex.
    // traceId is minted here (one per call, same as before - it was previously minted deeper in the
    // body) so the STARTED event and the H3 DESK_NO_TRADE below share the same correlation id.
    // Additive logging only: errors are rethrown unchanged, return values pass through untouched.
    const traceId = generateTraceId(symbol);
    const cycleId: string | null = options?.cycleCtx?.cycleId ?? null;
    const scheduledIndex: number | null = options?.cycleCtx?.scheduledIndex ?? null;
    observeSafe(() => structuredLogger.info('quant_symbol_eval_started', {
      category: 'DISCOVERY', eventType: 'QUANT_SYMBOL_EVAL_STARTED',
      cycleId, traceId, symbol, scheduledIndex,
    }));
    let outcome: 'ASSESSED' | 'INSUFFICIENT_BARS' | 'RATE_LIMITED' | 'ERROR' = 'ERROR';
    try {
      const result = await this.evaluateSymbolInternal(symbol, options, traceId);
      // evaluateSymbolInternal's only null return is the insufficient-bars early return below -
      // every other path returns a full evaluation.
      outcome = result === null ? 'INSUFFICIENT_BARS' : 'ASSESSED';
      return result;
    } catch (e: any) {
      // Same 429 wording the runCycle fan-out guard already uses to arm provider backoff.
      outcome = /429|rate-limited|Too Many Requests/i.test(String(e?.message || e)) ? 'RATE_LIMITED' : 'ERROR';
      throw e;
    } finally {
      observeSafe(() => structuredLogger.info('quant_symbol_eval_finished', {
        category: 'DISCOVERY', eventType: 'QUANT_SYMBOL_EVAL_FINISHED',
        cycleId, traceId, symbol, outcome,
      }));
    }
  }

  private async evaluateSymbolInternal(
    symbol: string,
    options: { emitIdeas?: boolean; cycleCtx?: { cycleId: string; scheduledIndex: number } } | undefined,
    traceId: string,
  ): Promise<QuantSymbolEvaluation> {
    const emitIdeas = options?.emitIdeas !== false;
    notePipelineAgentTick('QuantEngine');
    const endMs = Date.now();
    const startMs = endMs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

    try {
      await historicalDataGateway.ensureBars(symbol, TIMEFRAME, startMs, endMs);
    } catch (e: any) {
      // Cache-only path: ensureBars may throw when rate-limited with empty cache; if SQLite
      // already has enough bars from a prior session, continue. Never invent bars.
      const msg = String(e?.message || e);
      if (!/429|rate-limited|Too Many Requests/i.test(msg)) throw e;
      console.warn(`[QuantSignalAgent] ${symbol}: ensureBars rate-limited — attempting SQLite cache only`);
    }
    const bars: Bar[] = await historicalDataGateway.getBars(symbol, TIMEFRAME, startMs, endMs);
    observeSafe(() => structuredLogger.info('quant_bar_input_availability', {
      category: 'DISCOVERY', eventType: 'QUANT_BAR_INPUT_AVAILABILITY', symbol, traceId,
      timeframe: TIMEFRAME, requestedStartMs: startMs, requestedEndMs: endMs,
      barCount: bars.length, requiredBarCount: MIN_BARS_TO_EVALUATE,
      firstBarTimestamp: bars[0]?.timestamp ?? null, lastBarTimestamp: bars[bars.length - 1]?.timestamp ?? null,
      outcome: bars.length < MIN_BARS_TO_EVALUATE ? 'INSUFFICIENT_BARS' : 'SUFFICIENT_BAR_COUNT',
    }));

    if (bars.length < MIN_BARS_TO_EVALUATE) {
      console.log(`[QuantSignalAgent] ${symbol}: only ${bars.length} real bars available (need ${MIN_BARS_TO_EVALUATE}+) - skipping this cycle.`);
      // H3 (2026-10-09, Phase 3 certification): this early return used to be invisible to forensics
      // (no DB row, no event, console.log only). Emit the same DESK_NO_TRADE vocabulary the rest of
      // this agent uses. INSUFFICIENT_BARS is deliberately NOT folded into INSUFFICIENT_EVIDENCE:
      // INSUFFICIENT_EVIDENCE means "evaluations ran but nothing qualified", this means "we never
      // had enough real bars to evaluate at all" - a data-availability condition, and conflating
      // the two is exactly the audit finding the 2026-09-29 no-trade-code precision fix addressed.
      // Suppressed in evaluation-only mode (emitIdeas === false) per the fast-lane D1 rule that a
      // pure evaluation records no DESK_NO_TRADE.
      if (emitIdeas) {
        eventBus.emit(EVENTS.DESK_NO_TRADE, {
          traceId,
          symbol,
          code: 'INSUFFICIENT_BARS',
          reason: `Only ${bars.length} real bars available (need ${MIN_BARS_TO_EVALUATE}+) - skipping this cycle.`,
        });
      }
      return null;
    }

    // 2026-09-29 (intraday-bars-for-opening-range fix, docs/audits/archive/
    // ARGUS_MIDDAY_ZERO_TRADE_2026-09-29.md): real, verified gap - 2,027 of 2,072 quant assessments
    // that day reported OPENING_RANGE_BREAKOUT could not run because only daily-granularity bars
    // were ever fetched. computeSupportResistanceFeatures()'s openingRange()/premarketHighLow()
    // were already correctly honest about this (never fabricated a range from a daily candle) - the
    // actual missing piece was that this agent never even attempted an intraday fetch. Gated behind
    // the SAME isExperimentalStrategyLive() check StrategyEngine.ts already uses to decide whether
    // OPENING_RANGE_BREAKOUT participates in live evaluateAll() at all - zero added cost/behavior
    // change for every deployment that hasn't opted into this specific experimental strategy.
    // Best-effort and fail-open: any fetch failure leaves intradayBars undefined, and
    // computeSupportResistanceFeatures() falls back to its pre-existing behavior (daily bars,
    // openingRange honestly reports unavailable) - never blocks the real daily-bar evaluation this
    // method exists for.
    let intradayBars: Bar[] | undefined;
    // 2026-10-04 (opening-range session-anchoring fix): the real regular-session open for the
    // opening-range anchor - computed from the same fetch window so it always matches the bars.
    let intradaySessionOpenMs: number | undefined;
    if (isExperimentalStrategyLive('OPENING_RANGE_BREAKOUT')) {
      try {
        const window = computeIntradayFetchWindow(endMs);
        if (window) {
          try {
            await historicalDataGateway.ensureBars(symbol, INTRADAY_TIMEFRAME, window.startMs, window.endMs);
          } catch (e: any) {
            const msg = String(e?.message || e);
            if (!/429|rate-limited|Too Many Requests/i.test(msg)) throw e;
          }
          intradayBars = await historicalDataGateway.getBars(symbol, INTRADAY_TIMEFRAME, window.startMs, window.endMs);
          intradaySessionOpenMs = window.sessionOpenMs;
        }
      } catch (e) {
        console.warn(`[QuantSignalAgent] ${symbol}: intraday bar fetch for opening-range evaluation failed (non-fatal - falling back to daily-bar-only support/resistance features)`, e);
        intradayBars = undefined;
      }
    }

    const regime = classifyRegime(bars);
    // SHADOW-ONLY Java parity check (docs/architecture/ARGUS_ARCHITECTURE.md (Java Quant Core section) Phase
    // 2 feature-pipeline follow-up): never awaited - must add zero latency to evaluateSymbol and can
    // never affect its real return value. QuantCoreBridge.compareRegimeParity() is itself fully
    // fail-closed (disabled flag / open breaker / network error / non-2xx all no-op silently), but
    // `.catch()` alone only guards a REJECTED promise - if the call ever threw SYNCHRONOUSLY before
    // returning one (confirmed by a real test: a mocked/future implementation that throws before its
    // first `await`), `.catch()` is never reached and the exception would propagate straight into
    // this method. Wrapping the call itself in try/catch closes that gap regardless of how
    // compareRegimeParity fails.
    try {
      void quantCoreBridge.compareRegimeParity(symbol, bars, regime).catch(() => {});
    } catch {
      /* shadow diagnostics only - must never affect real evaluation */
    }
    const marketContext = await getMarketContext(symbol, bars, TIMEFRAME, startMs, endMs);
    const liveQuotePriceUsed = marketDataWorker.getLatestPrice(symbol);
    const currentPrice = resolveQuantCurrentPrice(bars[bars.length - 1], liveQuotePriceUsed, Date.now());

    // Real StrategyEngine context - reuses regime.features (trend/volatility/priceAction, already
    // computed by classifyRegime above) rather than recomputing them a second time; only momentum/
    // volume/supportResistance need computing here since RegimeResult doesn't carry those.
    const strategyContext: StrategyContext = {
      symbol,
      currentPrice,
      trend: regime.features.trend,
      volatility: regime.features.volatility,
      priceAction: regime.features.priceAction,
      momentum: computeMomentumFeatures(bars),
      // 2026-09-30 (ORB input-contract verification): intradayBars now also feeds VWAP (real
      // session-cumulative VWAP instead of a single-daily-bar degenerate approximation - see
      // computeVolumeFeatures's own doc comment). Same optional/additive shape and same gating as
      // supportResistance's own intradayBars parameter below - undefined outside the ORB flag,
      // zero behavior change for every other strategy/deployment.
      volume: computeVolumeFeatures(bars, intradayBars),
      supportResistance: computeSupportResistanceFeatures(bars, intradayBars, intradaySessionOpenMs),
      regime,
      marketContext,
      // Additive SMC snapshot. Does not change evaluateAll() unless QUANT_SMC_STRATEGY_ENABLED.
      smc: computeSmcFeatures(bars),
      ...(isMultiAssetEnabled() ? { assetClass: classifyAsset({ symbol, price: currentPrice }).assetClass } : {}),
    };
    const strategyEvaluations = evaluateAll(strategyContext);
    // SHADOW-ONLY Java CORE-strategy ensemble comparison (docs/audits/
    // ARGUS_JAVA_QUANT_AUTHORITY_ADR_2026-09-10.md §21 Phase 2/3): compares TS's own best-of-the-
    // 5-CORE-strategies pick against Java's real, bars-owning /api/v1/quant/ensemble/{symbol}
    // result (Java computes its own features from these same bars via
    // FeaturesToStrategyContextAdapter - never fed TS's precomputed strategyContext). Fire-and-
    // forget, wrapped in try/catch exactly like the existing compareRegimeParity call two lines
    // above - must add zero latency and can never affect the real emitted idea. Comparing only
    // against the CORE subset of strategyEvaluations (not the 16 experimental strategies Java
    // doesn't implement) keeps this an apples-to-apples check.
    try {
      void quantCoreBridge.fetchCoreEnsembleDecision(symbol, bars).then((javaEnsemble) => {
        if (!javaEnsemble) return;
        const coreIds = new Set(CORE_STRATEGIES.map((s) => s.id));
        const tsBest = bestStrategyIdea(strategyEvaluations.filter((e) => coreIds.has(e.strategy)));
        const tsSide = tsBest?.side ?? 'HOLD';
        const agree = tsSide === javaEnsemble.direction;
        observeSafe(() => {
          structuredLogger.info('quant_core_strategy_parity_divergence', {
            category: 'OBSERVABILITY',
            eventType: 'QUANT_CORE_STRATEGY_PARITY_DIVERGENCE',
            symbol,
            reasoning: `TS best-of-CORE=${tsSide} (conf ${tsBest?.confidence ?? 'n/a'}) vs Java ensemble=${javaEnsemble.direction} `
              + `(status ${javaEnsemble.status}, conf ${javaEnsemble.confidence.toFixed(2)}, effIndep ${javaEnsemble.effectiveIndependentCount.toFixed(2)}) - agree=${agree}`,
          });
        });
        // 2026-09-10, explicit operator override (see JavaCoreEnsembleVoteService.ts's own header) -
        // the real independent vote this shadow comparison feeds when eligible. Off by default
        // (ARGUS_JAVA_CORE_ENSEMBLE_VOTE_ENABLED); a no-op call when disabled. Wrapped defensively -
        // a throw here must never break this cycle's real TS-side evaluation below. Suppressed
        // entirely in evaluation-only mode (emitIdeas === false): a pure evaluation must not cast
        // a real vote one call-frame deeper than its caller intended (fast-lane D1, 2026-10-08).
        if (emitIdeas) {
          try {
            emitJavaCoreEnsembleVoteIfEligible(symbol, javaEnsemble, currentPrice);
          } catch {
            /* real vote path, but a failure here must never propagate into the surrounding evaluation */
          }
        }
      }).catch(() => {});
    } catch {
      /* shadow diagnostics only - must never affect real evaluation */
    }
    // Adaptive (default): all CORE evaluations stay in play; RegimeEngine + desk ranking pick the
    // highest-conviction setup. Manual Strategy Focus is a discretionary filter only.
    const { tradingEngine } = await import('../engines/TradingEngine');
    const focusId = normalizeStrategyFocus(tradingEngine.state.strategy);
    const focusedEvaluations = filterEvaluationsForStrategyFocus(strategyEvaluations, focusId);
    // Option B: per-ticker RegimeEngine → CORE subset (no capital sleeves).
    const adaptedEvaluations = selectEvaluationsForAdaptiveRegime(
      focusedEvaluations,
      focusId,
      regime.regime,
      regime.volatility,
    );
    const { recordCampaignScan, recordCampaignStrategyEval } = await import('./campaignEffortTelemetry');
    recordCampaignScan(1);
    recordCampaignStrategyEval({
      evaluated: adaptedEvaluations.length,
      rejected: adaptedEvaluations.filter((e) => !(e.confidence > 0)).length,
    });
    const paperOverlay = resolvePaperTestingOverlay(regime.regime);
    if (!paperOverlay.applied) {
      console.log(`[QuantSignalAgent] paper-testing overlay idle: ${paperOverlay.reason}`);
    }

    // Phase 6: grouped/probabilistic scores are direction-specific (see GroupedScores.ts's own
    // header on why), so both real candidate directions are computed and persisted here - whoever
    // ends up reading this later (the frontend panel, Phase 7's AI layer, Phase 8's Chief Trader
    // payload) can pick whichever side is actually relevant, rather than this agent guessing ahead
    // of time which one that will be.
    const groupedScores: { BUY: GroupedScores; SELL: GroupedScores } = {
      BUY: computeGroupedScores(strategyContext, 'BUY'),
      SELL: computeGroupedScores(strategyContext, 'SELL'),
    };

    recordQuantInputEvidence(symbol, traceId, () => ({
      capturedAtMs: Date.now(), timeframe: TIMEFRAME, strategyContext,
      liveQuotePriceUsed,
      bars, intradayBars: intradayBars ?? null, intradaySessionOpenMs: intradaySessionOpenMs ?? null,
      quoteAfterContext: marketDataWorker.getObservedQuoteEvidence(symbol),
      limitation: 'Quote is a later diagnostic observation, not proof of the quote used to resolve currentPrice. Bar provider availability timestamps and upstream benchmark input bars are not captured.',
    }));
    // Phase 13 (2026-08-31 real-edge audit): a strategy with real, repeatedly-verified negative
    // evidence (e.g. PULLBACK_CONTINUATION) can be quarantined from winning real selection without
    // stopping its background evaluation - strategyEvaluations (persisted below, unfiltered) and
    // adaptedEvaluations' own telemetry above are both completely unaffected; only the pool
    // bestStrategyIdea() actually picks from is filtered here.
    const emissionEligibleEvaluations = await filterQuarantinedStrategies(adaptedEvaluations);
    observeSafe(() => structuredLogger.info('quant_selection_pool', {
      category: 'DISCOVERY', eventType: 'QUANT_SELECTION_POOL', symbol, traceId, focusId,
      evaluatedStrategies: strategyEvaluations.map(e => e.strategy),
      focusedStrategies: focusedEvaluations.map(e => e.strategy),
      adaptedStrategies: adaptedEvaluations.map(e => e.strategy),
      emissionEligibleStrategies: emissionEligibleEvaluations.map(e => e.strategy),
    }));
    // Phase 4: the real Strategy Engine is the primary idea source; the Phase-3 regime-only mapping
    // is an honest fallback for when no individual strategy's own conditions clear its confidence bar.
    const ranked = rankEvaluationsForRegime(emissionEligibleEvaluations, regime.regime);
    const forPick = regime.volatility === 'HIGH'
      ? ranked.map(e => ({
          ...e,
          confidence: Math.round(e.confidence * deskIntelligence.highVolatilityConfidenceMultiplier * 100) / 100,
        }))
      : ranked;
    // Phase 15 (2026-09-01 bounded exploration, Rule 4): real evidence found 19 of 21 live
    // strategies never organically emit because bestStrategyIdea() always picks the single
    // highest-setupScore strategy, and the same few strategies dominate that ranking every cycle.
    // This reorders the candidate list only when a real, already-qualifying strategy has gone
    // unselected longer than a bounded cooldown, subject to a system-wide rate limit - never
    // changes any strategy's own confidence/setupScore, never touches quarantined strategies
    // (already filtered out of `forPick` above), and bestStrategyIdea()'s own
    // MIN_STRATEGY_CONFIDENCE_TO_TRADE bar still applies exactly as before.
    const explorationAdjusted = selectWithBoundedExploration(forPick);
    // Phase 18 (2026-09-01 rescue-fairness fix): classifies THIS symbol/cycle's rescue requests
    // (if any are needed later below) so MarketDataWorker's reserved-capacity rule can tell a rare,
    // bounded exploration/mover opportunity apart from a routine repeat-requester - real evidence
    // (Phase 17 audit) found the undifferentiated pool let a handful of routine repeat-requesters
    // (AAPL/TSLA/AI) permanently deny two real exploration promotions (CRM, ONON) RESCUE_CAPACITY_FULL.
    const wasExplorationPromoted = !!(explorationAdjusted[0] && forPick[0] && explorationAdjusted[0].strategy !== forPick[0].strategy);
    const isMarketMoverSymbol = !wasExplorationPromoted && getCachedMoverSymbols().includes(symbol.toUpperCase());
    // Phase 28 (2026-09-02 P0 discovery fix): confirmed root cause of the real FRVO incident
    // (2026-09-01) - a real, catalyst-backed candidate (genuine GlobeNewswire story, real
    // NewsCatalystStore evidence) was classified ROUTINE_RECOVERY, the SAME low-priority bucket as
    // an ordinary repeat-requester, and was denied a rescue 11/11 times. hasRealCatalystEvidence()
    // reuses the EXACT SAME reviewed strength/bias bar NewsCatalystStore already uses to decide
    // whether to stage a catalyst for market open - never a fabricated confidence, never "every
    // headline is high priority."
    const isNewsCatalystSymbol = !wasExplorationPromoted && !isMarketMoverSymbol && hasRealCatalystEvidence(symbol);
    const rescueRequestClass: RescueRequestClass = wasExplorationPromoted
      ? 'EXPLORATION'
      : isMarketMoverSymbol
        ? 'MARKET_MOVER'
        : isNewsCatalystSymbol
          ? 'NEWS_CATALYST'
          : 'ROUTINE_RECOVERY';
    // Observability gap found and fixed Phase 16 (2026-09-01): the scheduler itself is a pure
    // reordering function with no logging, so there was previously no way to tell "exploration
    // promoted a different strategy" apart from "regime-adaptive filtering naturally produced a
    // different top strategy" from persisted quant_assessments alone. This is the only new signal
    // Phase 16 adds - it never changes which strategy gets picked, only records when the pick
    // differs from what forPick's own ranking would have produced unmodified.
    if (wasExplorationPromoted) {
      observeSafe(() => {
        structuredLogger.info('strategy_exploration_promoted', {
          category: 'DISCOVERY',
          eventType: 'STRATEGY_EXPLORATION_PROMOTED',
          symbol,
          traceId,
          reasoning: `Exploration promoted ${explorationAdjusted[0].strategy} (setupScore ${explorationAdjusted[0].setupScore}) over the natural top-ranked ${forPick[0].strategy} (setupScore ${forPick[0].setupScore}).`,
        });
      });
    }
    let strategyIdea = bestStrategyIdea(explorationAdjusted);
    let matchedStrategyEvaluation = strategyIdea ? strategyEvaluations.find(e => e.strategy === strategyIdea!.strategy) ?? null : null;
    // Real strategy-attribution bug found and fixed (Master Transformation Mandate Part 7 audit,
    // 2026-09-13): captured BEFORE the cold-start-bootstrap branch below nulls
    // matchedStrategyEvaluation and reassigns strategyIdea.strategy to the synthetic marker string
    // 'COLD_START_BOOTSTRAP' - a live DB query this same pass found agent_predictions.strategy_id
    // (added in an earlier session) is populated on ZERO of 6,249 real QuantEngine rows, because
    // ReflectionEngine.ts's write of that column reads idea.quantDetail?.strategyEvaluation?.strategy,
    // which is exactly the field this cold-start path nulls - and per CLAUDE.md's own ground truth
    // (organic closed PAPER FILLED SELL P&L: 0), essentially every real QuantEngine idea today takes
    // this cold-start path. Until now the real strategy name (e.g. 'TREND_FOLLOWING') survived only
    // inside free-text reasoning ("Cold-start bootstrap: TREND_FOLLOWING is..."), which is exactly
    // why agentEdgeAnalytics.ts/predictionIndependencePolicy.ts had to resort to a reasoning-text
    // regex (secondaryGroupKey()) instead of a real column - the canonical identity never actually
    // reached the structured data. This constant is the fix: the real strategy identity, captured
    // once, independent of whether EV/stop/target end up backing the idea.
    const resolvedStrategyId: string | null = matchedStrategyEvaluation?.strategy ?? null;

    // Phase 16F (ARGUS_PHASE16_READINESS_REPORT.md) - a strategy-sourced idea (real stop/target,
    // unlike the regime-only fallback below) must clear a real expected-value check before it's
    // allowed to become a live trade idea, not just its own setup-confidence threshold. Uses the
    // exact same ExpectedValue.ts math BacktestEngine already reports (never duplicated), fed by a
    // real live win-rate estimate for this specific strategy (LiveStrategyPerformance.ts) rather
    // than an assumed one. Refuses (does not emit the strategy idea) below the same
    // MIN_SAMPLE_SIZE_FOR_KELLY-equivalent bar Kelly sizing already refuses under, or when the real
    // EV is non-positive - never fabricates a win-rate to let a candidate through. The regime-only
    // fallback below is unaffected - it never claimed EV backing in the first place.
    // 2026-09-29 (no-trade reason precision fix, docs/audits/archive/ARGUS_MIDDAY_ZERO_TRADE_2026-09-29.md):
    // previously every path that nulled `strategyIdea` below collapsed into the SAME generic
    // EXPECTED_VALUE_TOO_LOW/INSUFFICIENT_EVIDENCE pair at the DESK_NO_TRADE emission, conflating
    // five materially different real conditions (audit finding: 1,553 EXPECTED_VALUE_TOO_LOW events
    // that were "broader than its wording" — missing evidence, a genuinely negative measured EV,
    // insufficient outcome samples, poor risk/reward, and no eligible strategy at all, all reported
    // identically). Tracked explicitly here so an operator can distinguish "we measured a real,
    // non-positive edge" from "we never had enough evidence to measure one at all".
    let noTradeCode: string | null = null;
    if (strategyIdea && matchedStrategyEvaluation) {
      const stopPrice = matchedStrategyEvaluation.stop.price;
      const targetPrice = matchedStrategyEvaluation.target.price;
      // D3 (2026-10-07): computeEvGateRiskReward() fail-closes on directionally-inconsistent
      // stop/target (returns null -> EXPECTED_VALUE_UNCOMPUTABLE below) instead of letting a
      // direction-agnostic |distance| ratio through the EV gate.
      const rr = computeEvGateRiskReward(strategyIdea.side, currentPrice, stopPrice, targetPrice);
      const liveWinRate = await computeLiveStrategyWinRate(matchedStrategyEvaluation.strategy);
      // Real defect fixed this pass: a strategy with e.g. 1 closed trade (100% or 0% win rate) used
      // to be treated as a fully-trusted EV estimate here - the exact same MIN_SAMPLE_SIZE_FOR_KELLY
      // bar that fractionalKelly() already refuses under (this file's own prior comment claimed this
      // check existed; it did not). WARMING_UP (some samples, not yet statistically trustworthy) is
      // now treated the same as COLD_START (zero samples) for this gate - both fall through to the
      // same operator-gated bootstrap-or-refuse path below, never a fabricated "real edge" from noise.
      const isWarmingUp = !!liveWinRate && liveWinRate.sampleSize < MIN_SAMPLE_SIZE_FOR_KELLY;
      const ev = rr && liveWinRate && !isWarmingUp ? expectedValue(liveWinRate.winProbability, rr.ratio!) : null;

      if (!liveWinRate || isWarmingUp) {
        // Cold-start deadlock (ARGUS_PREDICTION_EDGE_AND_LEARNING_IMPLEMENTATION_AUDIT.md): this
        // strategy can never accumulate its own live win-rate history if it's never allowed to
        // emit a first idea. Off by default - only an operator who has explicitly set
        // QUANT_COLD_START_BOOTSTRAP_ENABLED=true accepts a regime-only (no EV, no computed
        // stop/target) bootstrap idea in its place. Still goes through the full ChiefTrader ->
        // RiskEngine (24 gates, including its own stopLossAssumptionPct-based sizing since this
        // idea carries no stop) -> OMS pipeline unchanged.
        const stateLabel = !liveWinRate ? 'COLD_START (zero real closed trades)' : `WARMING_UP (${liveWinRate.sampleSize} real closed trades, below the ${MIN_SAMPLE_SIZE_FOR_KELLY}-trade trust threshold)`;
        // Real bug found and fixed (Phase 12, 2026-08-31 zero-emission discrepancy investigation):
        // deriveIdeaFromRegime() structurally returns null for SIDEWAYS_RANGE (no directional
        // regime signal by design) and for BULLISH/BEARISH_TREND when regime.confidence itself is
        // thin - it was the ONLY source this bootstrap path ever consulted. Exact historical replay
        // of this real selection code against real quant_assessments rows proved RANGE_REVERSION
        // would have won real strategy selection ~2,742 times (confidence up to 0.944) - 100% of
        // them during SIDEWAYS_RANGE, where deriveIdeaFromRegime ALWAYS returns null. That is a
        // real, structural, total deadlock for any mean-reversion-family CORE strategy: it can only
        // ever win selection in the one regime this fallback refuses to handle. The strategy's own
        // real, already-computed side/confidence (bestStrategyIdea's own MIN_STRATEGY_CONFIDENCE_TO_
        // TRADE-cleared output, captured in `strategyIdea` before this block overwrites it) is real,
        // validated signal, not a fabrication - falling back to it when the regime alone gives no
        // directional read lets a genuinely-scored setup bootstrap the same way a trending-regime
        // one already could, without inventing anything new.
        const bootstrapIdea = isQuantColdStartBootstrapEnabled()
          ? deriveColdStartBootstrapIdea(regime, matchedStrategyEvaluation.strategy, strategyIdea.side, strategyIdea.confidence)
          : null;
        if (bootstrapIdea) {
          console.log(`[QuantSignalAgent] ${symbol}: ${matchedStrategyEvaluation.strategy} setup found but is ${stateLabel} - emitting a cold-start bootstrap idea instead (QUANT_COLD_START_BOOTSTRAP_ENABLED=true).`);
          strategyIdea = {
            side: bootstrapIdea.side,
            confidence: bootstrapIdea.confidence,
            strategy: 'COLD_START_BOOTSTRAP',
            reasoning: `${bootstrapIdea.reasoning} Cold-start bootstrap: ${matchedStrategyEvaluation.strategy} is ${stateLabel}, so no EV/stop/target backs this idea - operator-enabled via QUANT_COLD_START_BOOTSTRAP_ENABLED.`,
          };
          matchedStrategyEvaluation = null; // no real strategy evaluation backs this - stop/target/EV all stay null downstream, exactly like the pre-existing regime-only fallback
        } else {
          console.log(`[QuantSignalAgent] ${symbol}: ${matchedStrategyEvaluation.strategy} setup found but is ${stateLabel} for this strategy - no trustworthy EV estimate possible, not emitting a live trade idea from it.`);
          noTradeCode = 'INSUFFICIENT_SAMPLE';
          strategyIdea = null;
          matchedStrategyEvaluation = null;
        }
      } else if (!ev) {
        // rr/liveWinRate both exist here (the branch above already handled their absence) - `!ev`
        // means expectedValue() itself had nothing usable, i.e. riskRewardRatio() returned null
        // (missing/invalid stop or target price) OR computeEvGateRiskReward() refused a
        // directionally-inconsistent stop/target pair for this side (2026-10-07 D3) - a
        // data/setup gap, not a measured negative edge.
        // D1 honest interaction (2026-10-07, comment-only): TREND_FOLLOWING's target.price is
        // unconditionally null by design (trendFollowing.ts - trend-following trails a stop, it
        // never sets a fixed target), so rr is ALWAYS null for this strategy and it can never
        // pass the EV gate: before it accumulates a trustworthy live win-rate it takes the
        // cold-start/bootstrap-or-refuse path above, and once it does have one it ALWAYS lands
        // in THIS EXPECTED_VALUE_UNCOMPUTABLE branch - it can never emit a strategy-sourced
        // (EV-backed) idea, even though strategyFocus.json prefers it in every trend regime.
        // That is a real, permanent selection-vs-emission mismatch: TREND_FOLLOWING is
        // selection/ensemble-only until an honest trailing-target convention is defined - an
        // operator decision. Do NOT "fix" it here by inventing a target price; a fabricated
        // target would be worse than no emission at all.
        console.log(`[QuantSignalAgent] ${symbol}: ${matchedStrategyEvaluation.strategy} expected value is uncomputable (no usable stop/target risk-reward this cycle) - not emitting a live trade idea from it.`);
        noTradeCode = 'EXPECTED_VALUE_UNCOMPUTABLE';
        strategyIdea = null;
        matchedStrategyEvaluation = null;
      } else if (ev.expectedValueR <= 0) {
        console.log(`[QuantSignalAgent] ${symbol}: ${matchedStrategyEvaluation.strategy} real expected value is ${ev.expectedValueR.toFixed(3)}R (${liveWinRate.sampleSize} real closed trades, win rate ${(liveWinRate.winProbability * 100).toFixed(1)}%) - not a real edge, not emitting a live trade idea from it.`);
        noTradeCode = 'EXPECTED_VALUE_TOO_LOW';
        strategyIdea = null;
        matchedStrategyEvaluation = null;
      } else if (rr && rr.ratio !== null && rr.ratio < deskIntelligence.minRiskRewardRatio) {
        console.log(`[QuantSignalAgent] ${symbol}: ${matchedStrategyEvaluation.strategy} R:R ${rr.ratio.toFixed(2)} is below desk min ${deskIntelligence.minRiskRewardRatio} - NO TRADE.`);
        noTradeCode = 'POOR_RISK_REWARD';
        strategyIdea = null;
        matchedStrategyEvaluation = null;
      }
    }

    const idea = strategyIdea;
    if (!idea) {
      // noTradeCode is set above whenever a real strategyIdea existed and was then refused by the
      // EV/sample/R:R checks. When it's still null here, the idea never existed in the first place -
      // bestStrategyIdea() found no strategy clearing its own setup-confidence threshold this cycle
      // (NO_ELIGIBLE_STRATEGY) as distinct from having no evaluable strategies at all
      // (INSUFFICIENT_EVIDENCE, e.g. no qualifying bars/data this cycle).
      const code = noTradeCode ?? (strategyEvaluations.length > 0 ? 'NO_ELIGIBLE_STRATEGY' : 'INSUFFICIENT_EVIDENCE');
      eventBus.emit(EVENTS.DESK_NO_TRADE, {
        traceId,
        symbol,
        code,
        reason: 'Quant live emit requires a strategy idea that clears live EV and min R:R. Regime-only fallback is not a trade.',
        // 2026-10-10 (Part 21 selection-pool explainability): bounded breakdown of the
        // full selection chain, persisted with the event. Makes the next SNOW-style
        // "strategy triggered but never emitted" case answerable from evidence.
        selectionPool: buildSelectionPoolBreakdown({
          strategyEvaluations,
          focusedEvaluations,
          adaptedEvaluations,
          emissionEligibleEvaluations,
          economicsRefusal: noTradeCode ?? null,
        }),
      });
    }

    // Phase 7: AI contradiction/scenario review - only run when there's a real candidate idea to
    // review (never on a no-op cycle) and never allowed to touch idea.side/idea.confidence, which
    // stay exactly as the deterministic Strategy/Regime Engine computed them, per the plan's own
    // "AI must NOT overwrite deterministic calculations" rule. Degrades to available:false honestly
    // (see QuantContradictionAnalyzer.ts) when no AI provider is configured - never blocks the real
    // TRADE_IDEA_GENERATED emission below on this being available.
    // 2026-10-07 (Provider-D4): the wait is bounded via analyzeContradictionsBounded() -
    // tradingSafety.quantContradictionMaxWaitMs is a LATENCY BOUND, not a trading threshold. A
    // hung provider can no longer add unbounded latency to the idea path; the emission proceeds
    // with the same honest available:false degradation instead.
    let aiContradictionAnalysis: ContradictionAnalysisResult | null = null;
    if (idea) {
      aiContradictionAnalysis = await analyzeContradictionsBounded({
        symbol, side: idea.side, regime, strategyEvaluation: matchedStrategyEvaluation, groupedScores: groupedScores[idea.side],
      }, traceId);
    }

    let emittedTradeIdea = false;
    // Evaluation-only mode (emitIdeas === false, fast-lane D1 2026-10-08): the strategy
    // evaluations are returned for the caller to judge, but no idea is ever emitted and no
    // held-idea DESK_NO_TRADE is recorded - an evaluation is not a gated idea.
    if (emitIdeas && idea && isLiveIdeaGenerationEnabled() && isPipelineAgentEnabled('QuantEngine')) {
      const dataQuality = assessDataQuality(symbol);
      if (dataQuality.tradeBlocked) {
        // Phase 13 (2026-08-31 strategy-starvation remediation): a real, fully-constructed idea
        // (EV-backed or cold-start bootstrap) is about to be discarded ONLY because this symbol's
        // live data is stale/unsubscribed - never bypasses that block for THIS cycle (the idea is
        // still correctly discarded below), but requests a bounded, single-use rescue so the
        // strategy's NEXT evaluation cycle has a genuine shot at live data. See the Phase 13 audit:
        // MOMENTUM_BREAKOUT won real selection 249 times, 0 real emissions, all traced to exactly
        // this gate for exactly this reason (LNG/XOM outside the actively-streamed set).
        const rescueStrategyName = idea.strategy === 'COLD_START_BOOTSTRAP'
          ? (idea.reasoning.match(/Cold-start bootstrap: (\S+) is/)?.[1] ?? 'COLD_START_BOOTSTRAP')
          : idea.strategy;
        const rescue = marketDataWorker.requestTemporaryDataRescue(
          symbol,
          `QuantEngine:${rescueStrategyName}_stale_data_rescue`,
          { requestClass: rescueRequestClass, traceId },
        );
        eventBus.emit(EVENTS.DESK_NO_TRADE, {
          traceId, symbol, code: 'STALE_MARKET_DATA', reason: dataQuality.blockReason,
        });
        observeSafe(() => {
          structuredLogger.info('quant_idea_discarded_stale_data', {
            category: 'DISCOVERY',
            eventType: 'QUANT_IDEA_DISCARDED_STALE_DATA',
            symbol,
            traceId,
            reasoning: `${rescueStrategyName} idea discarded (${dataQuality.blockReason}). Rescue ${rescue.granted ? 'GRANTED' : `DENIED (${rescue.deniedReason})`}.`,
          });
        });
      } else {
      const catalysts = getNewsCatalysts(symbol);
      // Phase 9 (same-candidate convergence): a real, EV/R:R-cleared QuantEngine idea is exactly
      // the kind of "worth a look" signal ConfluenceCoordinator already records for TechnicalAgent -
      // recording it here too makes Fundamental/MacroAgent's priority round-robin bidirectional
      // (converge toward Quant's real signals, not only Technical's).
      recordCandidate(symbol);
      // 2026-09-09, explicit operator override (see ChiefTraderAgent.ts's doc comment on
      // isQuantIndependentQualificationEnabled). Only computed when the flag is on - zero extra
      // Java calls for every deployment that hasn't made this choice. Attached to evidence
      // regardless of outcome so real qualification/non-qualification history accumulates either
      // way; ChiefTraderAgent.ts is the only place this can actually change an approval.
      // 2026-10-07 (strategy-layer audit D4): the TS vote list is emissionEligibleEvaluations -
      // the SAME quarantine-filtered pool bestStrategyIdea() picks from - not the unfiltered
      // strategyEvaluations. A RETIRED/DEGRADED strategy's vote must never inflate
      // ENSEMBLE_CONFLUENCE or help clear the 2-of-4 support bar after being quarantined out of
      // selection; lifecycle-enforcement consistency, not a strategy change.
      const confluenceGuardOn = isStrategySelectionConfluenceGuardEnabled();
      const internalEnsemble = (isQuantIndependentQualificationEnabled() || confluenceGuardOn) && (idea.side === 'BUY' || idea.side === 'SELL')
        ? await computeInternalEnsembleQualification(symbol, bars, emissionEligibleEvaluations, idea.side)
        : null;
      // 2026-09-10, real observability gap closed (see InternalEnsembleQualification.sideMismatch's
      // own doc comment): when the broader correlation-adjusted ensemble disagrees with
      // bestStrategyIdea()'s picked side, this used to be indistinguishable from "agreed but
      // didn't clear the family/effective-count bar" - purely diagnostic evidence for measuring
      // whether top-1 strategy selection is discarding real, differently-directed confluence,
      // UNLESS strategySelectionConfluenceGuardEnabledEnvVar is also on (see below).
      if (internalEnsemble?.sideMismatch) {
        observeSafe(() => {
          structuredLogger.info('quant_confluence_side_mismatch', {
            category: 'OBSERVABILITY',
            eventType: 'QUANT_CONFLUENCE_SIDE_MISMATCH',
            symbol,
            traceId,
            reasoning: `bestStrategyIdea() picked ${idea.side}, but the broader correlation-adjusted ensemble `
              + `(${internalEnsemble.totalVotes} votes) resolved to ${internalEnsemble.rawSide} `
              + `(effIndep ${internalEnsemble.effectiveIndependentCount.toFixed(2)}) - `
              + `${confluenceGuardOn ? 'guard evaluated next' : 'diagnostic only, guard disabled'}.`,
          });
        });
      }
      // Strategy-selection confluence guard (2026-09-11, tradingSafety.strategySelectionConfluenceGuardEnabledEnvVar's
      // own doc comment has the full reasoning). Off by default. Only ever SUPPRESSES this cycle's
      // emission - never flips idea.side, never lowers any threshold, never invents a trade. Reuses
      // the exact same bar (minQuantIndependentFamilies/minQuantIndependentEffectiveCount) already
      // used to let the internal ensemble stand in for a second agent - if the ensemble's DISAGREEING
      // side is strong enough to have qualified as independent confirmation had it agreed, it's
      // treated as strong enough to block a contradicted top-1 pick from emitting at all.
      const confluenceGuardSuppresses = shouldSuppressForConfluenceGuard(
        confluenceGuardOn, internalEnsemble, tradingSafety.minQuantIndependentFamilies, tradingSafety.minQuantIndependentEffectiveCount,
      );
      if (confluenceGuardSuppresses && internalEnsemble) {
        eventBus.emit(EVENTS.DESK_NO_TRADE, {
          traceId, symbol, code: 'STRATEGY_SELECTION_CONFLUENCE_CONTRADICTED',
          reason: `bestStrategyIdea() picked ${idea.side} (${matchedStrategyEvaluation?.strategy ?? idea.strategy}), but the broader `
            + `correlation-adjusted ensemble resolved to ${internalEnsemble.rawSide} across ${internalEnsemble.familyCount} `
            + `distinct families (effIndep ${internalEnsemble.effectiveIndependentCount.toFixed(2)}) - suppressed, not emitted.`,
        });
        observeSafe(() => {
          structuredLogger.info('strategy_selection_confluence_suppressed', {
            category: 'DISCOVERY',
            eventType: 'STRATEGY_SELECTION_CONFLUENCE_SUPPRESSED',
            symbol,
            traceId,
            reasoning: `Suppressed ${idea.side} idea from ${matchedStrategyEvaluation?.strategy ?? idea.strategy} - `
              + `contradicted by a ${internalEnsemble.rawSide} ensemble clearing the independent-qualification bar.`,
          });
        });
      }
      // Everything below (emitTradeIdea through notePipelineAgentSuccess) is skipped when the guard
      // suppressed this cycle - emittedTradeIdea stays false, and QUANT_ASSESSMENT_COMPLETED /
      // quant_assessments persistence below (outside this whole if/else) still runs unaffected, so
      // this suppression remains fully visible to missed-opportunity forensics rather than vanishing.
      if (!confluenceGuardSuppresses) {
      eventBus.emitTradeIdea({
        traceId, symbol, side: idea.side, confidence: idea.confidence,
        currentPrice, reasoning: idea.reasoning, agent: 'QuantEngine',
        origin: 'QUANT_STRATEGY', // Phase 3 idea provenance: validated-quant idea path (real strategyId above; producer allowlist + lifecycle decide authority, not this tag)
        // Real strategy identity - survives independent of whether this idea ended up EV-backed
        // or cold-start-bootstrapped (see resolvedStrategyId's own comment above for why the
        // previous quantDetail.strategyEvaluation.strategy path silently dropped this for the
        // cold-start case, which is the overwhelming majority of real production volume today).
        strategyId: resolvedStrategyId,
        quantDetail: {
          regime,
          internalEnsemble,
          strategyEvaluation: matchedStrategyEvaluation,
          groupedScores: groupedScores[idea.side],
          contradictions: matchedStrategyEvaluation?.contradictions ?? [],
          aiContradictionAnalysis,
          featureSnapshot: snapshotFromStrategyContext({
            ctx: strategyContext,
            evaluations: strategyEvaluations,
            groupedScores,
            bars,
          }),
          ensembleRanking: ranked.map(e => ({
            strategy: e.strategy,
            regimeRelevance: e.regimeRelevance,
            ensembleScore: e.ensembleScore,
            setupScore: e.setupScore,
            confidence: e.confidence,
          })),
          dataQuality,
          newsCatalysts: catalysts.slice(0, 5),
          tradeThesis: assembleTradeThesis({
            symbol,
            ctx: strategyContext,
            evaluation: matchedStrategyEvaluation,
            ideaSide: idea.side,
            reasonsNotToTrade: [
              ...(matchedStrategyEvaluation?.contradictions ?? []),
              ...(matchedStrategyEvaluation?.conditionsFailed.map(c => `Unmet: ${c}`) ?? []),
              ...(catalysts.length === 0 ? ['No contemporaneous news catalyst (not required, but listed as why-not)'] : []),
            ],
            relativeStrengthVsSpy: strategyContext.marketContext.relativeStrengthVsSPY?.relativeStrengthPct ?? null,
            relativeStrengthVsSector: strategyContext.marketContext.relativeStrengthVsSector?.relativeStrengthPct ?? null,
            vwapDistancePct: strategyContext.volume.vwap.distancePct,
            catalystContribution: catalysts[0]?.contribution ?? null,
          }),
          eliteTraderDecision: buildEliteTraderDecision({
            symbol,
            regime,
            evaluation: matchedStrategyEvaluation,
            dataQuality,
            catalystContribution: catalysts[0]?.contribution ?? null,
            relativeStrengthVsSpy: strategyContext.marketContext.relativeStrengthVsSPY?.relativeStrengthPct ?? null,
            vwapDistancePct: strategyContext.volume.vwap.distancePct,
            contradictions: matchedStrategyEvaluation?.contradictions,
            newsEmitsTradeIdeas: newsAgentEmitsTradeIdeas(),
          }),
        },
      });
      emittedTradeIdea = true;
      notePipelineAgentSuccess('QuantEngine');
      // Master Transformation Mandate Part 7/9 (2026-09-13): real strategy-diversity evidence,
      // reusing internalEnsemble - already computed above for the confluence guard, never a second
      // Java call - passed through to the Forecast Engine so effectiveIndependentCount/familyCount
      // on a persisted forecast are the SAME canonical measurement ChiefTrader's own independent-
      // qualification bar uses, never a duplicate or approximated algorithm.
      // resolveEnsembleEvidenceForForecast() (internalQuantEnsemble.ts, independently unit tested)
      // owns the sideMismatch-exclusion decision. Fire-and-forget: this is real telemetry/
      // provenance, not a gate - it must never add latency or a new failure mode to the live
      // idea-emission path it rides along with, and it only ever fires at real idea-emission
      // cadence (bounded by this pipeline's own existing thresholds/cooldowns), never
      // per-evaluation-cycle.
      void buildForecast({
        agentName: 'QuantEngine',
        strategyId: resolvedStrategyId,
        symbol,
        direction: idea.side as 'BUY' | 'SELL',
        regime: regime.regime,
        ensembleEvidence: resolveEnsembleEvidenceForForecast(internalEnsemble),
      }).catch((e) => console.error(`[QuantSignalAgent] Forecast build failed for ${symbol}`, e));
      }
      }
    } else if (emitIdeas && idea) {
      // An eligible strategy candidate can be held before consensus. Persist that distinction
      // instead of making it indistinguishable from an EV rejection or an inactive worker.
      const enabled = isPipelineAgentEnabled('QuantEngine');
      eventBus.emit(EVENTS.DESK_NO_TRADE, {
        traceId, symbol,
        code: enabled ? 'IDEA_GENERATION_GATED' : 'AGENT_DISABLED',
        reason: enabled
          ? 'Quant strategy candidate held by the existing entry-generation gate (trading state, Autobot, restart reconciliation, campaign or forensic checkpoint).'
          : 'Quant strategy candidate held because QuantEngine is disabled in Mission Control.',
      });
    }

    eventBus.emit(EVENTS.QUANT_ASSESSMENT_COMPLETED, { traceId, symbol, regime, marketContext, strategyEvaluations, groupedScores, aiContradictionAnalysis, timestamp: new Date().toISOString(), emittedTradeIdea });
    observeSafe(() => structuredLogger.info('quant_quote_evidence', {
      category: 'DISCOVERY', eventType: 'QUANT_QUOTE_EVIDENCE', traceId, symbol,
      quote: marketDataWorker.getObservedQuoteEvidence(symbol),
      emittedTradeIdea,
    }));

    // 2026-10-09 (certification mission item 1 - OCT9_PIT_PROVENANCE_ESCAPE): per-decision
    // point-in-time replay provenance, on the REAL decision path. recordDecisionProvenance()
    // is synchronous, never throws, and never awaits — it adds negligible latency and can
    // never block or fail this decision (provenance is telemetry, never a gate). The row
    // records exactly what the decision consumed (bar IDs + available-at timestamps, the
    // observed quote + timestamps, the bounded+redacted StrategyContext, regime, strategy
    // versions, config version, build SHA, lifecycle states) plus what it produced
    // (strategyEvaluations + fingerprint), so replayQuantDecision() can later reproduce the
    // decision through the real evaluateAll() path. Gated in the same try/catch as the
    // assessment persist: an emission failure is logged, never propagated.
    try {
      const quoteEvidence = marketDataWorker.getObservedQuoteEvidence(symbol);
      const lastBar = bars[bars.length - 1];
      recordDecisionProvenance({
        decisionId: traceId,
        symbol,
        timeframe: TIMEFRAME,
        decisionTimeMs: Date.now(),
        bars: buildBarEvidence(symbol, TIMEFRAME, bars, endMs, 24 * 60 * 60 * 1000),
        quote: {
          price: quoteEvidence.observedPrice ?? null,
          observedAtMs: quoteEvidence.capturedAtMs != null && quoteEvidence.priceAgeMs != null
            ? quoteEvidence.capturedAtMs - quoteEvidence.priceAgeMs
            : null,
          source: quoteEvidence.source ?? null,
        },
        bid: { price: quoteEvidence.bid ?? null, observedAtMs: quoteEvidence.bidObservedAtMs ?? null },
        ask: { price: quoteEvidence.ask ?? null, observedAtMs: quoteEvidence.askObservedAtMs ?? null },
        currentPrice,
        // The resolved price came from the live quote when the last bar's day had not closed
        // yet (resolveQuantCurrentPrice), otherwise from the bar close observed at fetch time.
        priceObservedAtMs: !isDailyBarFinal(lastBar.timestamp, endMs, TRADING_TIMEZONE) &&
          quoteEvidence.capturedAtMs != null && quoteEvidence.priceAgeMs != null
          ? quoteEvidence.capturedAtMs - quoteEvidence.priceAgeMs
          : endMs,
        strategyContext,
        strategyEvaluations,
        strategyId: resolvedStrategyId,
        dataSource: 'QUANT_ENGINE',
      });
    } catch (e: any) {
      console.error(`[QuantSignalAgent] Failed to record decision provenance for ${symbol}`, e.message);
    }

    try {
      await db.insert(schema.quantAssessments).values({
        id: traceId,
        symbol,
        timeframe: TIMEFRAME,
        regime: JSON.stringify(regime),
        marketContext: JSON.stringify(marketContext),
        strategyEvaluations: JSON.stringify(strategyEvaluations),
        groupedScores: JSON.stringify(groupedScores),
        aiContradictionAnalysis: aiContradictionAnalysis ? JSON.stringify(aiContradictionAnalysis) : null,
        emittedTradeIdea,
        createdAt: new Date().toISOString(),
      });
    } catch (e: any) {
      console.error(`[QuantSignalAgent] Failed to persist assessment for ${symbol}`, e.message);
    }

    if (!emittedTradeIdea) {
      notePipelineAgentGated('QuantEngine');
    }

    return { regime, marketContext, strategyEvaluations, groupedScores, aiContradictionAnalysis };
  }
}

export const quantSignalAgent = new QuantSignalAgent();
