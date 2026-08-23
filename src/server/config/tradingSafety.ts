/**
 * Loads config/tradingSafety.json. This is the source of truth for operational/safety
 * thresholds that used to be scattered as module-level literals.
 *
 * Not exposed as a writable API. Restricted-live ceilings stay file-reviewed, never UI-tunable.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';
import { isRuntimeFlagEnabled } from './effectiveRuntimeConfig';

export interface TradingSafety {
  stalePriceThresholdMs: number;
  /** Reject ticks whose source timestamp is this far in the future (clock skew budget). */
  tickFutureSkewMs: number;
  /** Ignore out-of-order ticks older than last accepted tick by more than this epsilon. */
  tickOutOfOrderEpsilonMs: number;
  /** Dedup window for MARKET_DATA_REJECTED structured events (do not flood). */
  marketDataRejectLogDedupMs: number;
  marketClockCacheMs: number;
  maxConsecutiveLosses: number;
  correlationLookbackMs: number;
  disagreementPenalty: number;
  consensusApprovalThreshold: number;
  minIndependentAgreeingAgents: number;
  /** Must match config/strategyFocus.json defaultFocus. Catalog/modes stay in strategyFocus.json. */
  defaultStrategyFocus: string;
  openAliceUncertainBandLow: number;
  openAliceUncertainBandHigh: number;
  maxSingleSymbolConcentrationPct: number;
  maxSectorConcentrationPct: number;
  correlationMinOverlap: number;
  correlationThreshold: number;
  maxCorrelatedExposurePct: number;
  stopLossAssumptionPct: number;
  dailyLossKillSwitchFraction: number;
  defaultPercentOfEquityPct: number;
  restrictedLiveMaxOrderNotionalDollars: number;
  restrictedLiveMaxOpenPositions: number;
  restrictedLiveMaxDailyLossDollars: number;
  /** Paper/simulation daily BUY notional. 0 would skip the gate; production JSON must be > 0. LIVE also applies restrictedLiveMaxDailyBuyNotionalDollars. */
  maxDailyBuyNotionalDollars: number;
  restrictedLiveMaxDailyBuyNotionalDollars: number;
  alpacaRequestTimeoutMs: number;
  alpacaMaxRetries: number;
  alpacaRetryBaseDelayMs: number;
  alpacaCircuitBreakerFailureThreshold: number;
  alpacaCircuitBreakerCooldownMs: number;
  aiProviderTimeoutMs: number;
  aiProviderAuthFailureCooldownMs: number;
  /** Skip 404 / fetch-failed providers this long (in-memory; does not flip DB enabled). */
  aiProviderUnreachableCooldownMs: number;
  /** Skip a provider that timed out this long so NewsAgent does not re-pay the timeout every cycle. */
  aiProviderTimeoutSkipCooldownMs: number;
  /** Free-tier AlphaVantage shared daily HTTP cap (Fund + Macro). */
  alphaVantageDailyRequestBudget: number;
  /** Guard against a wedged shared budget-consumption lock permanently starving both Fundamental/MacroAgent. */
  alphaVantageBudgetLockTimeoutMs: number;
  /** Max parallel LLM providers for routeConsensus (top-K healthy). */
  consensusMaxProviders: number;
  /** Max NewsEngine LLM escalations per pipeline cycle. */
  newsLlmMaxCallsPerCycle: number;
  omsFollowUpMaxAgeMs: number;
  aiFailureWindowMs: number;
  aiFailureThresholdForLivePause: number;
  crashRecoveryLookbackMs: number;
  backtestLookbackBars: number;
  regimeMinBars: number;
  quantLookbackDays: number;
  quantCycleIntervalMs: number;
  /**
   * Max parallel symbol evaluations inside QuantSignalAgent.runCycle.
   * Default 1 (sequential) to reduce Alpaca 429 pressure; raise only after measuring
   * rate-limit headroom. Fail-closed on 429 still aborts the remainder of the cycle.
   */
  quantMaxConcurrentSymbols: number;
  predictionOutcomeIntervalMs: number;
  alertingCooldownMs: number;
  trainingExampleIntervalMs: number;
  marketRegimeIntervalMs: number;
  riskPctAggressive: number;
  riskPctConservative: number;
  riskPctBalanced: number;
  positionRiskElevatedFraction: number;
  debateTriggerConfidence: number;
  debateResultConfidence: number;
  /** Multiplier on debateResultConfidence when exactly 1 provider returned a usable verdict (not a genuine multi-model consensus). */
  debateSingleModelConfidencePenalty: number;
  /** Min gap between adversarial debate starts for the same symbol. Reliability, not a safety bypass. */
  consensusDebateCooldownMs: number;
  /** Min gap between non-forced consensus evaluations for the same symbol. */
  consensusEvalMinIntervalMs: number;
  /**
   * Debounce before evaluateConsensus after an entry idea lands, so Technical/Kronos/Quant
   * votes arriving within this window co-evaluate. Does not lower 0.75 / min-2 floors.
   */
  consensusAggregationWindowMs: number;
  /** Wall-clock budget for Opportunity Feed CONFIRM → agent co-eval → ChiefTrader consensus. */
  manualTradeCoEvalTimeoutMs: number;
  /** Skip Alpaca fetch when cached bars cover at least this fraction of expected trading days. */
  quantBarsCacheMinCoverageRatio: number;
  quantBarsRateLimitBaseBackoffMs: number;
  quantBarsRateLimitMaxBackoffMs: number;
  /** Idea-agent lastTickAt older than this is reported as enabled+dead. */
  pipelineAgentDeadAfterMs: number;
  debateLearnedRulesCount: number;
  debateLearnedRuleMaxChars: number;
  quantExitIdeaConfidence: number;
  quantStopExitConfidence: number;
  thesisInvalidationExitConfidence: number;
  regimeMismatchConfidenceMultiplier: number;
  minStrategyConfidenceToTrade: number;
  agentWinRateAlertPct: number;
  agentWinRateAlertMinPredictions: number;
  autoFlattenOnReconciliationMismatch: boolean;
  oosSharpeDegradationMinRatio: number;
  oosWinRateMinPct: number;
  permutationTestIterations: number;
  permutationSignificanceAlpha: number;
  newsVetoMinImpactScore: number;
  newsVetoWindowMs: number;
  newsClusterTimeWindowMs: number;
  newsClusterTitleSimilarityThreshold: number;
  newsRiskVetoThreshold: number;
  newsPredictionEvalIntradayMs: number;
  newsPredictionEvalShortTermMs: number;
  newsPredictionEvalMediumTermMs: number;
  newsPredictionEvalLongerTermMs: number;
  usEquityRthOpenMinute: number;
  usEquityRthCloseMinute: number;
  reconSignificantMismatchDollars: number;
  reconAccountConsistencyTolerancePct: number;
  reconAccountConsistencyToleranceFloorDollars: number;
  reconQtyTolerance: number;
  /** Position MISSING_LOCALLY / MISSING_REMOTELY must repeat this many cycles before TRADING_PAUSED. */
  reconPauseConsecutiveMismatchCycles: number;
  fallbackTakeProfitPct: number;
  fallbackTrailingStopPct: number;
  /** InternalPaperBroker seed cash. Not broker equity. Not researchInitialCapital. Not maxTradeSize. */
  internalPaperDefaultCash: number;
  /** Fallback order-notional cap when settings.maxTradeSize is unset. Not paper cash. */
  defaultMaxTradeSizeDollars: number;
  minSampleSizeForTrust: number;
  minTradesForPaperValidation: number;
  maxKellyFractionOfCapital: number;
  kellyFractionDefault: number;
  evaluationHorizonMs: number;
  /**
   * Kronos's own forecast horizon (config/quantThresholds.json kronosHorizon/kronosTimeframe) is
   * tick-based, not a wall-clock duration - there's no clean tick-to-ms conversion. This is a
   * separate, deliberate wall-clock window PredictionOutcomeEvaluator uses to grade Kronos
   * forecasts specifically, short enough to be closer to its real short-horizon forecast question
   * than the generic 60-minute evaluationHorizonMs (ARGUS_PREDICTIVE_EDGE_FORENSIC_AUDIT.md M5).
   */
  kronosEvaluationHorizonMs: number;
  tradingDaysPerYear: number;
  newsDecisiveSentimentThreshold: number;
  aiDecisionTemperature: number;
  minRegimeConfidenceToTrade: number;
  /**
   * Additive, default-off (env var must be exactly 'true'). When enabled, a strategy-sourced idea
   * refused solely for lack of live win-rate history (cold start - zero real closed trades yet for
   * that strategy) falls back to the regime-only mapping (deriveIdeaFromRegime) instead of no idea
   * at all. Still flows through the full ChiefTrader -> RiskEngine (24 gates) -> OMS pipeline
   * unchanged - never bypasses consensus or risk. See ARGUS_PREDICTION_EDGE_AND_LEARNING_
   * IMPLEMENTATION_AUDIT.md for the cold-start deadlock this addresses.
   */
  quantColdStartBootstrapEnabledEnvVar: string;
  /**
   * Phase 11 (ARGUS_INDEPENDENT_LEARNING_AND_REGIME_IMPLEMENTATION_AUDIT.md) - scaffold-only flag
   * for a future TradingAgents shadow/research adapter. No caller reads this yet; there is no
   * TradingAgents integration code in this repository at all. Exists so the config contract is
   * ready without implying the capability itself exists.
   */
  tradingAgentsShadowEnabledEnvVar: string;
  /**
   * docs/architecture/JAVA_QUANT_CORE_MIGRATION_BLUEPRINT.md Phase 2 - gates QuantCoreBridge.ts's
   * entire subscription to MARKET_DATA. Default off. Even when on, Phase 2 only forwards ticks
   * and logs shadow-parity divergence (ParityComparator.ts) - it does not call emitTradeIdea.
   * That is Phase 3, gated by this SAME flag plus its own additional checks in QuantCoreBridge.
   */
  quantJavaCoreEnabledEnvVar: string;
  /** Loopback-only base URL for the local Java advisory process. Never reachable off this host. */
  quantJavaCoreBaseUrl: string;
  /** Hard timeout for any single call to the Java process - must never add material latency to
   *  the live tick pipeline if Java is slow or down. */
  quantJavaCoreRequestTimeoutMs: number;
  /** Consecutive failures before QuantCoreBridge's circuit breaker opens (same shape as Alpaca's
   *  own circuitBreaker fields above - not reused directly since this breaker guards a distinct,
   *  purely-advisory dependency with no order-path consequence when open). */
  quantJavaCoreCircuitBreakerFailureThreshold: number;
  /** Cooldown before the circuit breaker allows another attempt after opening. */
  quantJavaCoreCircuitBreakerCooldownMs: number;
  /** ParityComparator.ts flags a shadow divergence when |ts - java| / |ts| exceeds this fraction
   *  (0.0001 = 0.01%, matching the migration blueprint's own stated threshold). */
  quantJavaCoreDivergenceThresholdPct: number;
  /**
   * ARGUS_INDEPENDENT_LEARNING_AND_REGIME_IMPLEMENTATION_AUDIT.md Phase 8 - maximum |delta| applied
   * to agent_performance_stats.currentWeight in a single evaluateAgents() cycle, in either
   * direction (toward a computed target when evidence is LEARNING_ELIGIBLE, or toward the agent's
   * static default weight when evidence drops to INSUFFICIENT_EVIDENCE). Prevents one noisy
   * effective-sample cycle from swinging live ChiefTrader weighting immediately to an extreme -
   * the same protective intent as a position-sizing cap, applied to learned weight instead of
   * capital.
   */
  maxWeightAdjustmentPerCycle: number;
  /**
   * Daily Goal Campaign, TRAIL_STOPS_ONLY action only: the tightened trailing-stop percentage
   * applied to open positions once today's target is reached under this action
   * (PortfolioMonitor.ts's resolveEffectiveTrailingStopPct). Only ever tightens the effective stop
   * (Math.min against the operator's own settings.trailingStopPct) - never loosens it.
   */
  campaignTrailStopsOnlyPct: number;
  /** Max concurrent open names while Daily Goal Campaign is enabled (tightens open_positions_cap). */
  campaignMaxConcurrentPositions: number;
  /** Per-trade notional ≤ budget * this fraction when campaign_enabled (velocity sizing). */
  campaignPositionBudgetFraction: number;
  campaignOpeningRvolMin: number;
  campaignOpeningRangeMinutes: number;
  campaignIntradayAtrTargetMultiple: number;
  campaignIntradayBreakevenPadPct: number;
  campaignEodFlattenEtMinutesBeforeClose: number;
  monteCarloDefaultSeed: number;
  sameSymbolCooldownMs: number;
  postLossCooldownMs: number;
  /** 0 = unlimited FILLED trades per NY session. */
  maxDailyTrades: number;
  duplicateSignalWindowMs: number;
  /** Drop ChiefTrader votes older than this so mismatched timestamps cannot masquerade as a live council. */
  consensusIdeaMaxAgeMs: number;
  /** Sliding-window cap on TRADE_IDEA_GENERATED after gates (defense vs idea storms). */
  maxTradeIdeasPerMinute: number;
  /** Sliding-window cap on AIRouter.routeTask (defense vs AI storms). Fail-closed HOLD. */
  maxAiCallsPerMinute: number;
  /** Value bounds for the safety-relevant numeric fields client-writable via POST /settings.
   * Real bug fixed: SETTINGS_ALLOWED_FIELDS only ever allowlisted field *names*, never validated
   * *values* - posting e.g. {"maxPortfolioDrawdownPct": 999} silently disabled the portfolio-
   * drawdown circuit breaker (the gate is just `drawdownPct < maxPortfolioDrawdownPct`). These
   * bounds close that class of bug for every numeric settings field RiskEngine/PositionSizing
   * reads a threshold from - see validateSettingsBounds in configRoutes.ts. */
  settingsBoundMaxPortfolioDrawdownPctMin: number;
  settingsBoundMaxPortfolioDrawdownPctMax: number;
  settingsBoundMaxOrdersPerMinuteMin: number;
  settingsBoundMaxOrdersPerMinuteMax: number;
  settingsBoundMaxOpenPositionsMin: number;
  settingsBoundMaxOpenPositionsMax: number;
  settingsBoundDailyLossLimitMin: number;
  settingsBoundDailyLossLimitMax: number;
  settingsBoundMaxTradeSizeMin: number;
  settingsBoundMaxTradeSizeMax: number;
  settingsBoundPercentOfEquityPctMin: number;
  settingsBoundPercentOfEquityPctMax: number;
  settingsBoundMinAiConfidenceMin: number;
  settingsBoundMinAiConfidenceMax: number;
  settingsBoundTakeProfitPctMin: number;
  settingsBoundTakeProfitPctMax: number;
  settingsBoundTrailingStopPctMin: number;
  settingsBoundTrailingStopPctMax: number;
  settingsBoundBudgetMin: number;
  settingsBoundBudgetMax: number;
  /** PortfolioRebalance.ts: skip a symbol whose current-vs-target drift is smaller than this many
   * percentage points of total equity - avoids submitting noise-sized trades for a position
   * that's already effectively at its target allocation. */
  rebalanceMinDriftPctOfEquity: number;
}

const REQUIRED_KEYS: (keyof TradingSafety)[] = [
  'stalePriceThresholdMs',
  'tickFutureSkewMs',
  'tickOutOfOrderEpsilonMs',
  'marketDataRejectLogDedupMs',
  'marketClockCacheMs',
  'maxConsecutiveLosses',
  'correlationLookbackMs',
  'disagreementPenalty',
  'consensusApprovalThreshold',
  'minIndependentAgreeingAgents',
  'openAliceUncertainBandLow',
  'openAliceUncertainBandHigh',
  'maxSingleSymbolConcentrationPct',
  'maxSectorConcentrationPct',
  'correlationMinOverlap',
  'correlationThreshold',
  'maxCorrelatedExposurePct',
  'stopLossAssumptionPct',
  'dailyLossKillSwitchFraction',
  'defaultPercentOfEquityPct',
  'restrictedLiveMaxOrderNotionalDollars',
  'restrictedLiveMaxOpenPositions',
  'restrictedLiveMaxDailyLossDollars',
  'maxDailyBuyNotionalDollars',
  'restrictedLiveMaxDailyBuyNotionalDollars',
  'alpacaRequestTimeoutMs',
  'alpacaMaxRetries',
  'alpacaRetryBaseDelayMs',
  'alpacaCircuitBreakerFailureThreshold',
  'aiProviderTimeoutMs',
  'aiProviderAuthFailureCooldownMs',
  'aiProviderUnreachableCooldownMs',
  'aiProviderTimeoutSkipCooldownMs',
  'alphaVantageDailyRequestBudget',
  'alphaVantageBudgetLockTimeoutMs',
  'consensusMaxProviders',
  'newsLlmMaxCallsPerCycle',
  'omsFollowUpMaxAgeMs',
  'alpacaCircuitBreakerCooldownMs',
  'aiFailureWindowMs',
  'aiFailureThresholdForLivePause',
  'crashRecoveryLookbackMs',
  'backtestLookbackBars',
  'regimeMinBars',
  'quantLookbackDays',
  'quantCycleIntervalMs',
  'quantMaxConcurrentSymbols',
  'predictionOutcomeIntervalMs',
  'alertingCooldownMs',
  'trainingExampleIntervalMs',
  'marketRegimeIntervalMs',
  'riskPctAggressive',
  'riskPctConservative',
  'riskPctBalanced',
  'positionRiskElevatedFraction',
  'debateTriggerConfidence',
  'debateResultConfidence',
  'debateSingleModelConfidencePenalty',
  'consensusDebateCooldownMs',
  'consensusEvalMinIntervalMs',
  'consensusAggregationWindowMs',
  'manualTradeCoEvalTimeoutMs',
  'quantBarsCacheMinCoverageRatio',
  'quantBarsRateLimitBaseBackoffMs',
  'quantBarsRateLimitMaxBackoffMs',
  'pipelineAgentDeadAfterMs',
  'debateLearnedRulesCount',
  'debateLearnedRuleMaxChars',
  'quantExitIdeaConfidence',
  'quantStopExitConfidence',
  'thesisInvalidationExitConfidence',
  'regimeMismatchConfidenceMultiplier',
  'minStrategyConfidenceToTrade',
  'agentWinRateAlertPct',
  'agentWinRateAlertMinPredictions',
  'oosSharpeDegradationMinRatio',
  'oosWinRateMinPct',
  'permutationTestIterations',
  'permutationSignificanceAlpha',
  'newsVetoMinImpactScore',
  'newsVetoWindowMs',
  'newsClusterTimeWindowMs',
  'newsClusterTitleSimilarityThreshold',
  'newsRiskVetoThreshold',
  'newsPredictionEvalIntradayMs',
  'newsPredictionEvalShortTermMs',
  'newsPredictionEvalMediumTermMs',
  'newsPredictionEvalLongerTermMs',
  'usEquityRthOpenMinute',
  'usEquityRthCloseMinute',
  'reconSignificantMismatchDollars',
  'reconAccountConsistencyTolerancePct',
  'reconAccountConsistencyToleranceFloorDollars',
  'reconQtyTolerance',
  'reconPauseConsecutiveMismatchCycles',
  'fallbackTakeProfitPct',
  'fallbackTrailingStopPct',
  'internalPaperDefaultCash',
  'defaultMaxTradeSizeDollars',
  'minSampleSizeForTrust',
  'minTradesForPaperValidation',
  'maxKellyFractionOfCapital',
  'kellyFractionDefault',
  'evaluationHorizonMs',
  'kronosEvaluationHorizonMs',
  'maxWeightAdjustmentPerCycle',
  'campaignTrailStopsOnlyPct',
  'campaignMaxConcurrentPositions',
  'campaignPositionBudgetFraction',
  'campaignOpeningRvolMin',
  'campaignOpeningRangeMinutes',
  'campaignIntradayAtrTargetMultiple',
  'campaignIntradayBreakevenPadPct',
  'campaignEodFlattenEtMinutesBeforeClose',
  'tradingDaysPerYear',
  'newsDecisiveSentimentThreshold',
  'aiDecisionTemperature',
  'minRegimeConfidenceToTrade',
  'monteCarloDefaultSeed',
  'sameSymbolCooldownMs',
  'postLossCooldownMs',
  'maxDailyTrades',
  'duplicateSignalWindowMs',
  'consensusIdeaMaxAgeMs',
  'maxTradeIdeasPerMinute',
  'maxAiCallsPerMinute',
  'settingsBoundMaxPortfolioDrawdownPctMin',
  'settingsBoundMaxPortfolioDrawdownPctMax',
  'settingsBoundMaxOrdersPerMinuteMin',
  'settingsBoundMaxOrdersPerMinuteMax',
  'settingsBoundMaxOpenPositionsMin',
  'settingsBoundMaxOpenPositionsMax',
  'settingsBoundDailyLossLimitMin',
  'settingsBoundDailyLossLimitMax',
  'settingsBoundMaxTradeSizeMin',
  'settingsBoundMaxTradeSizeMax',
  'settingsBoundPercentOfEquityPctMin',
  'settingsBoundPercentOfEquityPctMax',
  'settingsBoundMinAiConfidenceMin',
  'settingsBoundMinAiConfidenceMax',
  'settingsBoundTakeProfitPctMin',
  'settingsBoundTakeProfitPctMax',
  'settingsBoundTrailingStopPctMin',
  'settingsBoundTrailingStopPctMax',
  'settingsBoundBudgetMin',
  'settingsBoundBudgetMax',
  'rebalanceMinDriftPctOfEquity',
];

function loadTradingSafety(): TradingSafety {
  const raw = loadRepoConfigJson<Record<string, unknown>>('tradingSafety.json');
  for (const key of REQUIRED_KEYS) {
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key] as number)) {
      throw new Error(`config/tradingSafety.json missing numeric field: ${key}`);
    }
  }
  if (typeof raw.defaultStrategyFocus !== 'string' || !raw.defaultStrategyFocus) {
    throw new Error('config/tradingSafety.json missing string field: defaultStrategyFocus');
  }
  if (typeof raw.autoFlattenOnReconciliationMismatch !== 'boolean') {
    throw new Error('config/tradingSafety.json missing boolean field: autoFlattenOnReconciliationMismatch');
  }
  if (typeof raw.quantColdStartBootstrapEnabledEnvVar !== 'string' || !raw.quantColdStartBootstrapEnabledEnvVar) {
    throw new Error('config/tradingSafety.json missing string field: quantColdStartBootstrapEnabledEnvVar');
  }
  if (typeof raw.tradingAgentsShadowEnabledEnvVar !== 'string' || !raw.tradingAgentsShadowEnabledEnvVar) {
    throw new Error('config/tradingSafety.json missing string field: tradingAgentsShadowEnabledEnvVar');
  }
  if (typeof raw.quantJavaCoreEnabledEnvVar !== 'string' || !raw.quantJavaCoreEnabledEnvVar) {
    throw new Error('config/tradingSafety.json missing string field: quantJavaCoreEnabledEnvVar');
  }
  if (typeof raw.quantJavaCoreBaseUrl !== 'string' || !raw.quantJavaCoreBaseUrl) {
    throw new Error('config/tradingSafety.json missing string field: quantJavaCoreBaseUrl');
  }
  if (typeof raw.quantJavaCoreRequestTimeoutMs !== 'number') {
    throw new Error('config/tradingSafety.json missing number field: quantJavaCoreRequestTimeoutMs');
  }
  if (typeof raw.quantJavaCoreCircuitBreakerFailureThreshold !== 'number') {
    throw new Error('config/tradingSafety.json missing number field: quantJavaCoreCircuitBreakerFailureThreshold');
  }
  if (typeof raw.quantJavaCoreCircuitBreakerCooldownMs !== 'number') {
    throw new Error('config/tradingSafety.json missing number field: quantJavaCoreCircuitBreakerCooldownMs');
  }
  if (typeof raw.quantJavaCoreDivergenceThresholdPct !== 'number') {
    throw new Error('config/tradingSafety.json missing number field: quantJavaCoreDivergenceThresholdPct');
  }
  return raw as unknown as TradingSafety;
}

export const tradingSafety: TradingSafety = loadTradingSafety();

/** Scaffold-only - no caller uses this yet. See tradingAgentsShadowEnabledEnvVar's doc comment above. */
export function isTradingAgentsShadowEnabled(): boolean {
  return isRuntimeFlagEnabled(tradingSafety.tradingAgentsShadowEnabledEnvVar);
}

/** Off unless the operator has explicitly set this env var to 'true'. See quantColdStartBootstrapEnabledEnvVar's doc comment above. */
export function isQuantColdStartBootstrapEnabled(): boolean {
  return isRuntimeFlagEnabled(tradingSafety.quantColdStartBootstrapEnabledEnvVar);
}

/** Off unless the operator has explicitly set this env var to 'true'. See quantJavaCoreEnabledEnvVar's doc comment above. */
export function isQuantJavaCoreEnabled(): boolean {
  return isRuntimeFlagEnabled(tradingSafety.quantJavaCoreEnabledEnvVar);
}

export function portfolioRiskPctForLevel(riskLevel: string | undefined | null): number {
  if (riskLevel === 'Aggressive') return tradingSafety.riskPctAggressive;
  if (riskLevel === 'Conservative') return tradingSafety.riskPctConservative;
  return tradingSafety.riskPctBalanced;
}
