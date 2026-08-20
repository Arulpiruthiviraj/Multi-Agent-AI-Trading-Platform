/**
 * Loads config/tradingSafety.json. This is the source of truth for operational/safety
 * thresholds that used to be scattered as module-level literals.
 *
 * Not exposed as a writable API. Restricted-live ceilings stay file-reviewed, never UI-tunable.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

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
  tradingDaysPerYear: number;
  newsDecisiveSentimentThreshold: number;
  aiDecisionTemperature: number;
  minRegimeConfidenceToTrade: number;
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
  if (typeof raw.autoFlattenOnReconciliationMismatch !== 'boolean') {
    throw new Error('config/tradingSafety.json missing boolean field: autoFlattenOnReconciliationMismatch');
  }
  return raw as unknown as TradingSafety;
}

export const tradingSafety: TradingSafety = loadTradingSafety();

export function portfolioRiskPctForLevel(riskLevel: string | undefined | null): number {
  if (riskLevel === 'Aggressive') return tradingSafety.riskPctAggressive;
  if (riskLevel === 'Conservative') return tradingSafety.riskPctConservative;
  return tradingSafety.riskPctBalanced;
}
