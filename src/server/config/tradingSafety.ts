/**
 * Loads config/tradingSafety.json. This is the source of truth for operational/safety
 * thresholds that used to be scattered as module-level literals.
 *
 * Not exposed as a writable API. Restricted-live ceilings stay file-reviewed, never UI-tunable.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

export interface TradingSafety {
  stalePriceThresholdMs: number;
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
  /** 0 = unlimited in paper/simulation. LIVE always also applies restrictedLiveMaxDailyBuyNotionalDollars. */
  maxDailyBuyNotionalDollars: number;
  restrictedLiveMaxDailyBuyNotionalDollars: number;
  alpacaCircuitBreakerFailureThreshold: number;
  alpacaCircuitBreakerCooldownMs: number;
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
  debateLearnedRulesCount: number;
  debateLearnedRuleMaxChars: number;
  quantExitIdeaConfidence: number;
  quantStopExitConfidence: number;
  thesisInvalidationExitConfidence: number;
  regimeMismatchConfidenceMultiplier: number;
  minStrategyConfidenceToTrade: number;
  agentWinRateAlertPct: number;
  agentWinRateAlertMinPredictions: number;
}

const REQUIRED_KEYS: (keyof TradingSafety)[] = [
  'stalePriceThresholdMs',
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
  'alpacaCircuitBreakerFailureThreshold',
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
  'debateLearnedRulesCount',
  'debateLearnedRuleMaxChars',
  'quantExitIdeaConfidence',
  'quantStopExitConfidence',
  'thesisInvalidationExitConfidence',
  'regimeMismatchConfidenceMultiplier',
  'minStrategyConfidenceToTrade',
  'agentWinRateAlertPct',
  'agentWinRateAlertMinPredictions',
];

function loadTradingSafety(): TradingSafety {
  const raw = loadRepoConfigJson<Record<string, unknown>>('tradingSafety.json');
  for (const key of REQUIRED_KEYS) {
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key] as number)) {
      throw new Error(`config/tradingSafety.json missing numeric field: ${key}`);
    }
  }
  return raw as unknown as TradingSafety;
}

export const tradingSafety: TradingSafety = loadTradingSafety();

export function portfolioRiskPctForLevel(riskLevel: string | undefined | null): number {
  if (riskLevel === 'Aggressive') return tradingSafety.riskPctAggressive;
  if (riskLevel === 'Conservative') return tradingSafety.riskPctConservative;
  return tradingSafety.riskPctBalanced;
}
