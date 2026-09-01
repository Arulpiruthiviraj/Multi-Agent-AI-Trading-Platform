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
import { marketDataWorker } from './MarketDataWorker';
import { historicalDataGateway, Bar } from '../engines/backtest/HistoricalDataGateway';
import { getRegisteredHistoricalBarProvider } from '../engines/backtest/historicalBarProvider';
import { classifyRegime, RegimeResult } from '../quant/RegimeEngine';
import { getMarketContext, MarketContextResult } from '../quant/MarketContext';
import { computeMomentumFeatures } from '../quant/indicators/momentum';
import { computeVolumeFeatures } from '../quant/indicators/volume';
import { computeSupportResistanceFeatures } from '../quant/indicators/supportResistance';
import { computeSmcFeatures } from '../quant/indicators/smc';
import { evaluateAll, bestStrategyIdea } from '../quant/strategies/StrategyEngine';
import { filterQuarantinedStrategies } from '../quant/strategies/StrategyEmissionEligibility';
import { selectWithBoundedExploration } from '../quant/strategies/StrategyExplorationScheduler';
import { resolvePaperTestingOverlay } from '../research/paperTestingOverlay';
import { snapshotFromStrategyContext } from '../quant/QuantitativeFeatureEngine';
import { assembleTradeThesis } from '../quant/thesis/assembleTradeThesis';
import { StrategyContext, StrategyEvaluation } from '../quant/strategies/types';
import { computeGroupedScores, GroupedScores } from '../quant/scoring/GroupedScores';
import { recordCandidate } from '../core/recentCandidateRegistry';
import { analyzeContradictions, ContradictionAnalysisResult } from '../quant/ai/QuantContradictionAnalyzer';
import { riskRewardRatio, expectedValue, MIN_SAMPLE_SIZE_FOR_KELLY } from '../quant/risk/ExpectedValue';
import { computeLiveStrategyWinRate } from '../quant/risk/LiveStrategyPerformance';
import { MIN_BARS } from '../quant/RegimeEngine';
import { tradingSafety, isQuantColdStartBootstrapEnabled } from '../config/tradingSafety';
import { isRuntimeFlagEnabled, resolveRuntimeNumber } from '../config/effectiveRuntimeConfig';
import { deskIntelligence, rankEvaluationsForRegime, newsAgentEmitsTradeIdeas } from '../config/deskIntelligence';
import { filterEvaluationsForStrategyFocus, normalizeStrategyFocus, selectEvaluationsForAdaptiveRegime } from '../config/strategyFocus';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';
import { isPipelineAgentEnabled } from '../core/pipelineAgentGate';
import { notePipelineAgentFailure, notePipelineAgentGated, notePipelineAgentSuccess, notePipelineAgentTick } from '../core/pipelineAgentHealth';
import { assessDataQuality } from '../core/dataQuality';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';
import { getNewsCatalysts } from './NewsCatalystStore';
import { buildEliteTraderDecision } from '../desk/EliteTraderDecision';
import { isMultiAssetEnabled } from '../config/multiAsset';
import { classifyAsset } from '../multiAsset/AssetClassifier';

const DEFAULT_CYCLE_INTERVAL_MS = tradingSafety.quantCycleIntervalMs;
const LOOKBACK_DAYS = tradingSafety.quantLookbackDays;
const TIMEFRAME = '1Day';
const MIN_BARS_TO_EVALUATE = MIN_BARS;

// Kept for unit tests of the historical regime mapping. Live evaluateSymbol must NOT emit this
// as a trade idea — no EV, stop, or target.
const MIN_REGIME_CONFIDENCE_TO_TRADE = tradingSafety.minRegimeConfidenceToTrade;

export interface DerivedIdea {
  side: 'BUY' | 'SELL';
  confidence: number; // 0-1, same scale every other TRADE_IDEA_GENERATED emitter uses
  reasoning: string;
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

export class QuantSignalAgent {
  private intervalId: NodeJS.Timeout | null = null;

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
    console.log(`[QuantSignalAgent] Starting - real regime/market-context evaluation every ${cycleMs / 1000}s for actively-tracked symbols.`);
    this.runCycle().catch(e => console.error('[QuantSignalAgent] Initial cycle failed', e));
    this.intervalId = setInterval(() => {
      this.runCycle().catch(e => console.error('[QuantSignalAgent] Cycle failed', e));
    }, cycleMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private symbolConcurrency(): number {
    const n = tradingSafety.quantMaxConcurrentSymbols;
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(32, Math.floor(n));
  }

  private async runCycle(): Promise<void> {
    const active = marketDataWorker.getActiveSymbols();
    // Prefer liquid names that Quant needs most often — still only evaluates subscribed symbols.
    const priority = ['SPY', 'QQQ', 'NVDA', 'HOOD', 'COIN', 'AMD', 'RIOT', 'AAPL', 'MSFT', 'META'];
    const symbols = [
      ...priority.filter((s) => active.includes(s) || active.includes(s.toUpperCase())),
      ...active.filter((s) => !priority.includes(s.toUpperCase()) && !priority.includes(s)),
    ].map((s) => s.toUpperCase()).filter((s, i, arr) => arr.indexOf(s) === i);

    if (symbols.length === 0) {
      console.log('[QuantSignalAgent] No actively-tracked symbols yet (MarketDataWorker has no subscriptions) - nothing to evaluate this cycle.');
      notePipelineAgentGated('QuantEngine');
      return;
    }
    const concurrency = Math.min(this.symbolConcurrency(), symbols.length);
    let nextIndex = 0;
    let abortRateLimit = false;
    let anySuccess = false;
    const workers = Array.from({ length: concurrency }, async () => {
      while (!abortRateLimit) {
        const i = nextIndex++;
        if (i >= symbols.length) return;
        const symbol = symbols[i];
        try {
          const result = await this.evaluateSymbol(symbol);
          if (result) anySuccess = true;
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
        }
      }
    });
    await Promise.all(workers);
    if (anySuccess) {
      notePipelineAgentSuccess('QuantEngine');
    } else if (abortRateLimit) {
      notePipelineAgentGated('QuantEngine');
    }
  }

  async evaluateSymbol(symbol: string): Promise<{ regime: RegimeResult; marketContext: MarketContextResult; strategyEvaluations: StrategyEvaluation[]; groupedScores: { BUY: GroupedScores; SELL: GroupedScores }; aiContradictionAnalysis: ContradictionAnalysisResult | null } | null> {
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

    if (bars.length < MIN_BARS_TO_EVALUATE) {
      console.log(`[QuantSignalAgent] ${symbol}: only ${bars.length} real bars available (need ${MIN_BARS_TO_EVALUATE}+) - skipping this cycle.`);
      return null;
    }

    const regime = classifyRegime(bars);
    const marketContext = await getMarketContext(symbol, bars, TIMEFRAME, startMs, endMs);
    const currentPrice = bars[bars.length - 1].close;

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
      volume: computeVolumeFeatures(bars),
      supportResistance: computeSupportResistanceFeatures(bars),
      regime,
      marketContext,
      // Additive SMC snapshot. Does not change evaluateAll() unless QUANT_SMC_STRATEGY_ENABLED.
      smc: computeSmcFeatures(bars),
      ...(isMultiAssetEnabled() ? { assetClass: classifyAsset({ symbol, price: currentPrice }).assetClass } : {}),
    };
    const strategyEvaluations = evaluateAll(strategyContext);
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

    const traceId = generateTraceId(symbol);
    // Phase 13 (2026-08-31 real-edge audit): a strategy with real, repeatedly-verified negative
    // evidence (e.g. PULLBACK_CONTINUATION) can be quarantined from winning real selection without
    // stopping its background evaluation - strategyEvaluations (persisted below, unfiltered) and
    // adaptedEvaluations' own telemetry above are both completely unaffected; only the pool
    // bestStrategyIdea() actually picks from is filtered here.
    const emissionEligibleEvaluations = await filterQuarantinedStrategies(adaptedEvaluations);
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
    // Observability gap found and fixed Phase 16 (2026-09-01): the scheduler itself is a pure
    // reordering function with no logging, so there was previously no way to tell "exploration
    // promoted a different strategy" apart from "regime-adaptive filtering naturally produced a
    // different top strategy" from persisted quant_assessments alone. This is the only new signal
    // Phase 16 adds - it never changes which strategy gets picked, only records when the pick
    // differs from what forPick's own ranking would have produced unmodified.
    if (explorationAdjusted[0] && forPick[0] && explorationAdjusted[0].strategy !== forPick[0].strategy) {
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

    // Phase 16F (ARGUS_PHASE16_READINESS_REPORT.md) - a strategy-sourced idea (real stop/target,
    // unlike the regime-only fallback below) must clear a real expected-value check before it's
    // allowed to become a live trade idea, not just its own setup-confidence threshold. Uses the
    // exact same ExpectedValue.ts math BacktestEngine already reports (never duplicated), fed by a
    // real live win-rate estimate for this specific strategy (LiveStrategyPerformance.ts) rather
    // than an assumed one. Refuses (does not emit the strategy idea) below the same
    // MIN_SAMPLE_SIZE_FOR_KELLY-equivalent bar Kelly sizing already refuses under, or when the real
    // EV is non-positive - never fabricates a win-rate to let a candidate through. The regime-only
    // fallback below is unaffected - it never claimed EV backing in the first place.
    if (strategyIdea && matchedStrategyEvaluation) {
      const stopPrice = matchedStrategyEvaluation.stop.price;
      const targetPrice = matchedStrategyEvaluation.target.price;
      const rr = stopPrice !== null && targetPrice !== null ? riskRewardRatio(currentPrice, stopPrice, targetPrice) : null;
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
          strategyIdea = null;
          matchedStrategyEvaluation = null;
        }
      } else if (!ev || ev.expectedValueR <= 0) {
        console.log(`[QuantSignalAgent] ${symbol}: ${matchedStrategyEvaluation.strategy} real expected value is ${ev ? ev.expectedValueR.toFixed(3) + 'R' : 'uncomputable'} (${liveWinRate.sampleSize} real closed trades, win rate ${(liveWinRate.winProbability * 100).toFixed(1)}%) - not a real edge, not emitting a live trade idea from it.`);
        strategyIdea = null;
        matchedStrategyEvaluation = null;
      } else if (rr && rr.ratio !== null && rr.ratio < deskIntelligence.minRiskRewardRatio) {
        console.log(`[QuantSignalAgent] ${symbol}: ${matchedStrategyEvaluation.strategy} R:R ${rr.ratio.toFixed(2)} is below desk min ${deskIntelligence.minRiskRewardRatio} - NO TRADE.`);
        strategyIdea = null;
        matchedStrategyEvaluation = null;
      }
    }

    const idea = strategyIdea;
    if (!idea) {
      eventBus.emit(EVENTS.DESK_NO_TRADE, {
        traceId,
        symbol,
        code: strategyEvaluations.some(e => e.confidence >= 0.01) ? 'EXPECTED_VALUE_TOO_LOW' : 'INSUFFICIENT_EVIDENCE',
        reason: 'Quant live emit requires a strategy idea that clears live EV and min R:R. Regime-only fallback is not a trade.',
      });
    }

    // Phase 7: AI contradiction/scenario review - only run when there's a real candidate idea to
    // review (never on a no-op cycle) and never allowed to touch idea.side/idea.confidence, which
    // stay exactly as the deterministic Strategy/Regime Engine computed them, per the plan's own
    // "AI must NOT overwrite deterministic calculations" rule. Degrades to available:false honestly
    // (see QuantContradictionAnalyzer.ts) when no AI provider is configured - never blocks the real
    // TRADE_IDEA_GENERATED emission below on this being available.
    let aiContradictionAnalysis: ContradictionAnalysisResult | null = null;
    if (idea) {
      aiContradictionAnalysis = await analyzeContradictions({
        symbol, side: idea.side, regime, strategyEvaluation: matchedStrategyEvaluation, groupedScores: groupedScores[idea.side],
      }, traceId);
    }

    let emittedTradeIdea = false;
    if (idea && isLiveIdeaGenerationEnabled() && isPipelineAgentEnabled('QuantEngine')) {
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
      eventBus.emitTradeIdea({
        traceId, symbol, side: idea.side, confidence: idea.confidence,
        currentPrice, reasoning: idea.reasoning, agent: 'QuantEngine',
        quantDetail: {
          regime,
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
      }
    }

    eventBus.emit(EVENTS.QUANT_ASSESSMENT_COMPLETED, { traceId, symbol, regime, marketContext, strategyEvaluations, groupedScores, aiContradictionAnalysis, timestamp: new Date().toISOString(), emittedTradeIdea });

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
