/**
 * ==========================================================
 * Module: quant/quantEvidenceAdapters
 *
 * Milestone B (2026-09-23): pure mapping functions from the two currently-wired Java vote
 * producers' EXISTING response shapes (`InstitutionalAdvisoryResult`/`QuantAdvisoryPayload` for
 * `JavaFactorComposite`, `CoreEnsembleDecision` for `JavaCoreEnsemble`) into the new canonical
 * `QuantEvidence` contract (`./QuantEvidence.ts`).
 *
 * Purely additive and read-only: these functions consume an already-fetched response object and
 * return a NEW, separate `QuantEvidence` value. They do not call `QuantCoreBridge`, do not touch
 * `eventBus.emitTradeIdea`, and are not imported by `JavaCoreEnsembleVoteService.ts` or
 * `JavaQuantAdvisoryService.ts`'s own vote-eligibility functions (`emitJavaCoreEnsembleVoteIfEligible`/
 * `emitJavaQuantVoteIfEligible`) - those two functions' control flow is byte-for-byte unchanged by
 * this file's existence. See `QuantEvidence.ts`'s own header for the full scope boundary.
 *
 * Every field below was decided by actually reading the real response interfaces in
 * `QuantCoreBridge.ts` (`InstitutionalAdvisoryResult`, `CoreEnsembleDecision`, `CoreStrategyAssessment`)
 * - nothing here is guessed. Where a producer's real response has no honest source for a
 * QuantEvidence field, the field is `NULL_NOT_SUPPORTED` (structurally absent) or
 * `NOT_YET_CALIBRATED` (conceptually possible, not yet backed by real calibration evidence) - see
 * `QUANT_EVIDENCE_CAPABILITY_MATRIX.md` for the full producer x field matrix and the reasoning
 * behind every cell, including ones that were a close call between REAL_VALUE and DERIVED.
 * ==========================================================
 */
import type { InstitutionalAdvisoryResult, CoreEnsembleDecision } from '../services/QuantCoreBridge';
import type { QuantAdvisoryPayload } from '../services/QuantAdvisoryPayload';
import {
  type QuantEvidence,
  type EvidenceDirection,
  realValue,
  derivedValue,
  notSupported,
  notYetCalibrated,
} from './QuantEvidence';

function sideToDirection(side: 'BUY' | 'SELL' | 'HOLD' | 'NEUTRAL'): EvidenceDirection {
  if (side === 'BUY' || side === 'SELL') return side;
  return 'HOLD';
}

/**
 * JavaFactorComposite (`FactorAlphaEngine.java`'s 5-factor Z-score composite, reached via
 * `QuantCoreBridge.fetchInstitutionalAdvisory()`). Accepts either the raw bridge response
 * (`InstitutionalAdvisoryResult`) or the already-built `QuantAdvisoryPayload` wrapper
 * `JavaQuantAdvisoryService.ts` actually streams/votes from, since both carry the same real fields
 * under the same names.
 *
 * Field-by-field honesty notes (see the capability matrix doc for the full table):
 * - `rawScore`/`confidence`: `rawAvgConfidence`/`adjustedConfidence` are real Java-computed numbers
 *   (the latter after the Regime/Volatility Multiplier Layer, itself real Java math) - REAL_VALUE.
 * - `normalizedScore`: no separate 0-1 "normalized score" concept distinct from confidence exists
 *   in this response - NULL_NOT_SUPPORTED rather than reusing confidence under a second name.
 * - `predictedReturn`/`predictedVolatility`/`downsideRisk`/`upsidePotential`/`probabilityUp/Down/Flat`:
 *   FactorAlphaEngine outputs a composite Z-score-like signal, not a calibrated return/volatility/
 *   probability distribution forecast - none of these exist in the response. NULL_NOT_SUPPORTED.
 * - `uncertainty`: no explicit uncertainty/confidence-interval field. NULL_NOT_SUPPORTED.
 * - `calibrationStatus`: `agent_confidence_calibration`/ModelPerformanceTracker tracks this agent's
 *   real historical calibration, but that is a SEPARATE lookup this pure mapper does not perform
 *   (no DB access here) - honestly reported as NOT_YET_CALIBRATED at the mapper level, meaning "not
 *   resolved by this adapter", not a claim that no calibration data will ever exist.
 * - `regime`: `regime` is a real Java HMM-classified label. REAL_VALUE.
 * - `estimatedTransactionCostBps`/`netExpectedReturn`: this response carries no cost estimate at
 *   all. NULL_NOT_SUPPORTED, `costQuality: 'NOT_APPLICABLE'`.
 * - `dataFreshness`/`inputCompleteness`: not carried on this response shape (freshness is checked
 *   separately, downstream, against MarketDataWorker's live tick cache - not part of this payload).
 *   NULL_NOT_SUPPORTED.
 */
export function mapJavaFactorCompositeToQuantEvidence(
  advisory: InstitutionalAdvisoryResult | QuantAdvisoryPayload,
): QuantEvidence {
  return {
    producer: 'JavaFactorComposite',
    engineVersion: `schemaVersion=${advisory.schemaVersion}`,
    strategyId: null, // composite output, no single constituent strategy id on this response
    methodologyFamily: 'FACTOR_MODEL',
    dataDependency: 'CANONICAL_BARS',
    timeHorizon: 'DAILY',
    direction: sideToDirection(advisory.rawSide),

    rawScore: realValue(advisory.rawAvgConfidence),
    normalizedScore: notSupported(),
    confidence: realValue(advisory.adjustedConfidence),

    predictedReturn: notSupported(),
    predictedVolatility: notSupported(),
    downsideRisk: notSupported(),
    upsidePotential: notSupported(),

    probabilityUp: notSupported(),
    probabilityDown: notSupported(),
    probabilityFlat: notSupported(),

    uncertainty: notSupported(),
    calibrationStatus: 'NOT_YET_CALIBRATED',
    calibrationSampleSize: notYetCalibrated(),

    regime: realValue(advisory.regime),

    estimatedTransactionCostBps: notSupported(),
    netExpectedReturn: notSupported(),
    costQuality: 'NOT_APPLICABLE',
    netReturnAvailable: false,

    dataFreshness: notSupported(),
    inputCompleteness: notSupported(),

    provenance: `JavaFactorComposite advisory: rawSide=${advisory.rawSide}, gated=${advisory.gated}, `
      + `regimeMultiplier=${advisory.regimeMultiplier}, volatilityMultiplier=${advisory.volatilityMultiplier}, `
      + `agreeingModelIds=${advisory.agreeingModelIds.join(',')}, dissentingModelIds=${advisory.dissentingModelIds.join(',')}`,
  };
}

/**
 * JavaCoreEnsemble (`CoreStrategyRunner.java`'s 5 CORE strategies combined via
 * `QuantEnsembleEngine.java`, reached via `QuantCoreBridge.fetchCoreEnsembleDecision()`).
 *
 * Field-by-field honesty notes (see the capability matrix doc for the full table):
 * - `rawScore`/`confidence`: `score`/`confidence` are real Java ensemble-computed numbers.
 *   REAL_VALUE.
 * - `normalizedScore`: `effectiveIndependentCount / strategyCount` is a real, deterministic
 *   transform of two real fields already on the response (a 0-1 "how independently-agreed is this"
 *   ratio) - not a raw engine output field by that name, so DERIVED, not REAL_VALUE. Only computed
 *   when `strategyCount > 0` (guards a divide-by-zero); NULL_NOT_SUPPORTED otherwise, never a
 *   fabricated 0.
 * - `predictedReturn`/`predictedVolatility`/`downsideRisk`/`upsidePotential`/`probabilityUp/Down/Flat`:
 *   CoreStrategyRunner's ensemble decision is a directional score/confidence, not a calibrated
 *   return/volatility/probability forecast. NULL_NOT_SUPPORTED.
 * - `uncertainty`: no explicit field. NULL_NOT_SUPPORTED.
 * - `calibrationStatus`: same reasoning as the factor-composite mapper above - resolved elsewhere
 *   (ModelPerformanceTracker), not by this pure mapper. NOT_YET_CALIBRATED at the mapper level.
 * - `regime`: `regime` is a real (nullable) string field Java itself populates. REAL_VALUE when
 *   non-null, NULL_NOT_SUPPORTED when Java itself returned null for this evaluation.
 * - `estimatedTransactionCostBps`/`netExpectedReturn`: no cost estimate on this response.
 *   NULL_NOT_SUPPORTED, `costQuality: 'NOT_APPLICABLE'`.
 * - `dataFreshness`: not carried on `CoreEnsembleDecision` itself (freshness is checked separately
 *   by `JavaCoreEnsembleVoteService.ts` against MarketDataWorker's live tick cache, not part of this
 *   response). NULL_NOT_SUPPORTED.
 * - `inputCompleteness`: `agreeingCount / strategyCount` is a real, deterministic ratio of two real
 *   fields already on the response (how many of the 5 CORE strategies actually produced a usable
 *   assessment and agreed) - DERIVED, guarded against divide-by-zero the same way as normalizedScore.
 */
export function mapJavaCoreEnsembleToQuantEvidence(decision: CoreEnsembleDecision): QuantEvidence {
  const hasStrategyCount = Number.isFinite(decision.strategyCount) && decision.strategyCount > 0;
  return {
    producer: 'JavaCoreEnsemble',
    engineVersion: `schemaVersion=${decision.schemaVersion}, featureVersion=${decision.featureVersion}, strategyVersion=${decision.strategyVersion}`,
    strategyId: null, // ensemble decision spans 5 contributing strategies, no single constituent id
    methodologyFamily: 'TECHNICAL_ENSEMBLE',
    dataDependency: 'CANONICAL_BARS',
    timeHorizon: 'INTRADAY',
    direction: sideToDirection(decision.direction),

    rawScore: realValue(decision.score),
    normalizedScore: hasStrategyCount
      ? derivedValue(decision.effectiveIndependentCount / decision.strategyCount)
      : notSupported(),
    confidence: realValue(decision.confidence),

    predictedReturn: notSupported(),
    predictedVolatility: notSupported(),
    downsideRisk: notSupported(),
    upsidePotential: notSupported(),

    probabilityUp: notSupported(),
    probabilityDown: notSupported(),
    probabilityFlat: notSupported(),

    uncertainty: notSupported(),
    calibrationStatus: 'NOT_YET_CALIBRATED',
    calibrationSampleSize: notYetCalibrated(),

    regime: decision.regime !== null ? realValue(decision.regime) : notSupported(),

    estimatedTransactionCostBps: notSupported(),
    netExpectedReturn: notSupported(),
    costQuality: 'NOT_APPLICABLE',
    netReturnAvailable: false,

    dataFreshness: notSupported(),
    inputCompleteness: hasStrategyCount
      ? derivedValue(decision.agreeingCount / decision.strategyCount)
      : notSupported(),

    provenance: `JavaCoreEnsemble decision: status=${decision.status}, direction=${decision.direction}, `
      + `agreeingCount=${decision.agreeingCount}/${decision.strategyCount}, `
      + `effectiveIndependentCount=${decision.effectiveIndependentCount}, `
      + `contributingStrategies=${decision.contributingStrategies.join(',')}, `
      + `contributingFamilies=${decision.contributingFamilies.join(',')}, reason=${decision.reason}`,
  };
}
