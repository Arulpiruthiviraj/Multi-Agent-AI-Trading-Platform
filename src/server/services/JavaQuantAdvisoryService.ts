/**
 * Phase 2 of the Java engine activation plan (docs/audits/ARGUS_POST_MIGRATION_ARCHITECTURE_AUDIT.md,
 * config/engineOwnership.json): gives the previously-zero-consumer Java institutional models
 * (GARCH, HMM regime, factor composite) a real, on-demand consumer.
 *
 * Deliberately advisory-only, matching engineOwnership.json's own notes for these models:
 * - Does NOT call eventBus.emitTradeIdea - only the generic EventBus.emit for observability.
 * - Does NOT import or touch EvidenceAggregator, ChiefTraderAgent, RiskEngine, OrderManagement,
 *   or BrokerManager.
 * - Wiring QUANT_ADVISORY_ANALYSIS_COMPLETED into the consensus vote is Phase 3 of the activation
 *   plan - an explicit, separate, NOT-YET-TAKEN decision. That plan itself warns that Java
 *   evidence must enter as one vote among many, never automatic approval, and that correlated
 *   evidence must not be double-counted - both unresolved design questions this service
 *   deliberately does not attempt to answer by simply existing.
 * - Off entirely unless isQuantJavaCoreEnabled() (same base flag QuantCoreBridge.ts already
 *   gates on) - zero timer, zero network calls, zero-op when disabled.
 * - Fails closed on every real-data dependency (historicalDataGateway, the Java HTTP calls):
 *   any failure just skips that symbol's analysis for this tick, never throws, never fabricates
 *   a result.
 */
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { isQuantJavaCoreEnabled } from '../config/tradingSafety';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { resolveIdeaUniverse } from '../core/ideaUniverse';
import { historicalDataGateway } from '../engines/backtest/HistoricalDataGateway';
import { quantCoreBridge, type EnsembleModelVote, type EnsembleSide } from './QuantCoreBridge';
import { buildQuantAdvisoryPayload } from './QuantAdvisoryPayload';
import { recordPrediction } from './ModelPerformanceTracker';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';
import type { ResearchBar } from '../research/ohlcvTypes';

// Reasoned (not fabricated) mapping from FactorAlphaEngine's composite Z-score-like output into an
// ensemble vote: sign gives direction, magnitude (clamped) gives confidence. composite is already
// a real Java-computed value (5-factor Z-score average) - this just puts it in the {side,
// confidence} shape QuantEnsembleEngine needs, the same kind of transformation TechnicalAgent
// already does turning RSI/MACD into a confidence. 2.0 is a reasoned scale (most composite values
// observed in practice fall within +-2), not a backtested constant - same honesty discipline as
// RegimeVolatilityOverlay's own declared assumptions.
const FACTOR_CONFIDENCE_SCALE = 2.0;
const MIN_FACTOR_CONFIDENCE = 0.05;
const MAX_FACTOR_CONFIDENCE = 0.95;

function factorCompositeToVote(composite: number): EnsembleModelVote | null {
  if (!Number.isFinite(composite) || composite === 0) return null;
  const side: EnsembleSide = composite > 0 ? 'BUY' : 'SELL';
  const confidence = Math.max(MIN_FACTOR_CONFIDENCE, Math.min(MAX_FACTOR_CONFIDENCE, Math.abs(composite) / FACTOR_CONFIDENCE_SCALE));
  return { modelId: 'factor_composite', family: 'factor', side, confidence };
}

// Real floor GarchEngine/HmmRegimeEngine themselves enforce (30 returns / 40 observations) plus
// margin - matches this codebase's convention of deriving gate values from the same math the
// callee uses rather than an arbitrary round number. See GarchEngine.fit()/HmmRegimeEngine.fit().
const MIN_BARS_FOR_ANALYSIS = 60;
const LOOKBACK_DAYS = 260;
const TIMEFRAME = '1Day';

class JavaQuantAdvisoryService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private cursor = 0;

  start(): void {
    if (this.intervalId || !isQuantJavaCoreEnabled()) return;
    this.intervalId = setInterval(() => {
      this.tick().catch(() => { /* analyzeSymbol already fails closed internally; defense in depth */ });
    }, runtimeIntervals.javaQuantAdvisoryMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async tick(): Promise<void> {
    if (!isQuantJavaCoreEnabled()) return;
    const universe = resolveIdeaUniverse();
    if (universe.length === 0) return;
    const symbol = universe[this.cursor % universe.length];
    this.cursor += 1;
    await this.analyzeSymbol(symbol);
  }

  /** Exported as a standalone step - real per-symbol analysis, callable directly (tests, a future manual trigger) without needing a live timer tick. */
  async analyzeSymbol(symbol: string): Promise<void> {
    if (!isQuantJavaCoreEnabled()) return;
    const startedAt = Date.now();

    let bars: ResearchBar[];
    try {
      const endMs = Date.now();
      const startMs = endMs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
      await historicalDataGateway.ensureBars(symbol, TIMEFRAME, startMs, endMs);
      bars = await historicalDataGateway.getBars(symbol, TIMEFRAME, startMs, endMs);
    } catch (e) {
      observeSafe(() => {
        structuredLogger.warn('java_quant_advisory_bars_failed', {
          category: 'OBSERVABILITY',
          eventType: 'QUANT_ADVISORY_BARS_FAILED',
          symbol,
          error: e instanceof Error ? e.message : String(e),
        });
      });
      return;
    }
    if (bars.length < MIN_BARS_FOR_ANALYSIS) return;

    const [garch, regime, factor, features] = await Promise.all([
      quantCoreBridge.fetchInstitutionalVolatility(symbol, bars),
      quantCoreBridge.fetchInstitutionalRegime(symbol, bars),
      quantCoreBridge.fetchInstitutionalFactors(symbol, bars),
      quantCoreBridge.fetchInstitutionalFeatures(symbol, bars),
    ]);
    // Correlation deliberately NOT fetched here, same reasoning as statArb/pairs below - it's
    // inherently cross-symbol (needs 2+ aligned return series), not a fit for this single-symbol
    // per-tick loop. A future cross-sectional consumer would call
    // quantCoreBridge.fetchInstitutionalCorrelation() directly across a chosen symbol set.

    const latencyMs = Date.now() - startedAt;
    // Plain EventBus.emit (observability only) - not emitTradeIdea. No agent name, no side, no
    // confidence field shaped like a vote; this is explicitly not a TRADE_IDEA_GENERATED payload.
    eventBus.emit(EVENTS.QUANT_ADVISORY_ANALYSIS_COMPLETED, {
      symbol,
      timestamp: new Date().toISOString(),
      models: { garch, regime, factor, features, statArb: null, correlation: null },
      health: {
        javaAvailable: garch !== null || regime !== null || factor !== null || features !== null,
        latencyMs,
      },
    });

    // Dynamic Regime & Volatility Multiplier Layer: only attempted when we have a real directional
    // vote (factor_composite - the one DIRECTIONAL_ALPHA_PROVIDER this loop computes, per
    // config/engineOwnership.json's outputType tagging) AND real conditioning inputs (regime,
    // realized volatility). garch/regime being CONDITIONING_* (not directional) is exactly why
    // they never become ensemble votes themselves - see QuantEnsembleEngine.java's own header.
    if (factor !== null && regime !== null && garch !== null) {
      const vote = factorCompositeToVote(factor.composite);
      if (vote !== null) {
        const advisory = await quantCoreBridge.fetchInstitutionalAdvisory([vote], regime.currentRegime, garch.realizedVolatility);
        if (advisory !== null) {
          const payload = buildQuantAdvisoryPayload(symbol, advisory);
          // Non-blocking telemetry: fire-and-forget emit, never awaited by anything upstream of
          // this periodic tick. QUANT_ADVISORY_PAYLOAD_STREAMED is a distinct event type nothing
          // in the live decision spine subscribes to - see QuantAdvisoryPayload.ts's own header.
          eventBus.emit(EVENTS.QUANT_ADVISORY_PAYLOAD_STREAMED, payload);
          observeSafe(() => {
            structuredLogger.info('quant_advisory_payload_streamed', {
              category: 'OBSERVABILITY',
              eventType: 'QUANT_ADVISORY_PAYLOAD_STREAMED',
              symbol,
              rawSide: advisory.rawSide,
              adjustedConfidence: advisory.adjustedConfidence,
              gated: advisory.gated,
              regime: advisory.regime,
            });
          });
          // ModelPerformanceTracker foundations: records this call for later predicted-vs-realized
          // grading via the EXISTING PredictionOutcomeEvaluator/ReflectionEngine pipeline - a
          // direct DB write, never eventBus.emitTradeIdea (see ModelPerformanceTracker.ts's own
          // safety note for why that distinction is load-bearing).
          void recordPrediction({
            agentName: 'JavaFactorComposite',
            symbol,
            side: advisory.rawSide === 'NEUTRAL' ? 'HOLD' : advisory.rawSide,
            confidence: advisory.adjustedConfidence,
            reasoning: advisory.reasoning,
            regime: advisory.regime,
          });
        }
      }
    }
  }
}

export const javaQuantAdvisoryService = new JavaQuantAdvisoryService();
