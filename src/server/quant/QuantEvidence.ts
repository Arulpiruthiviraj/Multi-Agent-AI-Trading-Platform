/**
 * ==========================================================
 * Module: quant/QuantEvidence
 *
 * Milestone B (2026-09-23): a canonical, producer-agnostic evidence contract for every Java quant
 * engine output Argus currently has a live consumer for. This is purely a NEW, ADDITIONAL,
 * READ-ONLY observability/normalization view over responses `QuantCoreBridge.ts` already fetches.
 *
 * Hard scope boundary (see CLAUDE.md § "Java 26 Engine Authority" / § "ARGUS CORE ARCHITECTURE"):
 * this module does NOT vote, does NOT gate, does NOT feed ChiefTrader/RiskEngine/OMS/PositionSizing,
 * and does NOT change `emitTradeIdea` eligibility for `JavaFactorComposite` or `JavaCoreEnsemble`.
 * Nothing in this file is imported by `evidenceIndependence.ts`, `ChiefTraderAgent.ts`,
 * `RiskEngine.ts`, `OrderManagement.ts`, `PositionSizing.ts`, or `BrokerManager`. Its only job is to
 * let an operator/observability consumer compare what every Java producer actually outputs, in one
 * shared shape, with an honest per-field label for whether the number is real.
 *
 * Same "never fabricate - label what's real vs. inferred vs. null" discipline as
 * `quant/risk/ExpectedValue.ts` (never invents an EV/Kelly fraction it can't statistically justify)
 * and `research/organicPaper.ts` (never counts a row as organic without real evidence) - applied
 * here to Java engine OUTPUT FIELDS instead of trade evidence rows.
 * ==========================================================
 */

/** Exactly the four labels the operator specified - no fifth label, no synonyms. */
export type FieldProvenance =
  /** A real, directly-observed value the Java engine itself computed from real market/feature data. */
  | 'REAL_VALUE'
  /** Computed in TypeScript (or by Java) from one or more REAL_VALUE inputs via an explicit,
   *  reviewed, non-fabricated transformation (e.g. sign+magnitude mapped into a confidence). Not
   *  itself a raw engine output, but not invented either - the transform is documented at the call
   *  site that sets it. */
  | 'DERIVED'
  /** The producer's real response shape has no field, and no honest derivation exists, for this
   *  QuantEvidence field. Always `null` on the value side - never a placeholder number. */
  | 'NULL_NOT_SUPPORTED'
  /** The producer COULD in principle carry this concept (e.g. a probability distribution, a
   *  calibrated cost estimate) but the current implementation has not been calibrated/validated
   *  against real outcomes yet, so surfacing a number here would overstate confidence. Value is
   *  `null` until real calibration evidence exists - this is a distinct reason from
   *  NULL_NOT_SUPPORTED and consumers should not conflate the two. */
  | 'NOT_YET_CALIBRATED';

/** Methodology family - a coarse, honest classification of HOW the producer arrives at its output,
 *  not a strategy-id (no strategy-id literals belong outside config/*.json per CLAUDE.md; this is a
 *  methodology descriptor, not a tradable strategy membership list). */
export type MethodologyFamily =
  | 'TECHNICAL_ENSEMBLE'       // e.g. JavaCoreEnsemble's 5 CORE technical/momentum/mean-reversion strategies
  | 'FACTOR_MODEL'             // e.g. JavaFactorComposite's 5-factor Z-score composite
  | 'VOLATILITY_MODEL'         // GARCH/EGARCH family
  | 'REGIME_MODEL'             // HMM regime classification
  | 'STATISTICAL_ARBITRAGE'
  | 'MACHINE_LEARNING'
  | 'UNKNOWN';

export type DataDependency = 'CANONICAL_BARS' | 'LIVE_TICK' | 'CROSS_SYMBOL_CORRELATION' | 'MIXED' | 'UNKNOWN';

export type TimeHorizon = 'INTRADAY' | 'DAILY' | 'MULTI_DAY' | 'UNKNOWN';

export type EvidenceDirection = 'BUY' | 'SELL' | 'HOLD' | 'DATA_UNAVAILABLE';

/** Same three-state honesty as OMS/RiskEngine's own freshness handling - never invent freshness. */
export type CalibrationStatus = 'CALIBRATED' | 'NOT_YET_CALIBRATED' | 'NOT_APPLICABLE';

/**
 * One field's value plus its provenance label. The generic keeps the pairing mechanical so every
 * field on `QuantEvidence` is forced to declare both, rather than a value-only shape where
 * provenance could silently drift out of sync.
 */
export interface ProvenancedField<T> {
  value: T | null;
  provenance: FieldProvenance;
}

/**
 * The canonical, producer-agnostic evidence contract. Every field the operator specified, each
 * wrapped as a `ProvenancedField` so a consumer can inspect a value AND its honesty label together.
 * `producer`/`engineVersion`/`strategyId`/`methodologyFamily`/`dataDependency`/`timeHorizon`/
 * `direction`/`provenance` (top-level) are plain (non-provenanced) identity/classification fields -
 * they describe WHICH evidence this is, not a measured quantity that could be fabricated.
 */
export interface QuantEvidence {
  /** Agent name exactly as it appears in `agent_performance_stats`/`emitTradeIdea` payloads today
   *  (e.g. 'JavaFactorComposite', 'JavaCoreEnsemble') - never a new agent identity invented here. */
  producer: string;
  /** Java-side schemaVersion + strategy/feature version strings the response already carries,
   *  concatenated for a single human-readable field. Never fabricated if the source response omits
   *  one of these - falls back to whichever parts are actually present. */
  engineVersion: string;
  /** The specific strategy/model id within the producer, when the response identifies one (e.g. a
   *  single CoreStrategyAssessment's strategyId). Null for a producer whose response is already an
   *  ensemble/composite with no single constituent id (e.g. the factor composite). */
  strategyId: string | null;

  methodologyFamily: MethodologyFamily;
  dataDependency: DataDependency;
  timeHorizon: TimeHorizon;

  /** Directional call as the engine itself reported it - not re-derived or re-interpreted here. */
  direction: EvidenceDirection;

  rawScore: ProvenancedField<number>;
  normalizedScore: ProvenancedField<number>;
  confidence: ProvenancedField<number>;

  predictedReturn: ProvenancedField<number>;
  predictedVolatility: ProvenancedField<number>;
  downsideRisk: ProvenancedField<number>;
  upsidePotential: ProvenancedField<number>;

  probabilityUp: ProvenancedField<number>;
  probabilityDown: ProvenancedField<number>;
  probabilityFlat: ProvenancedField<number>;

  uncertainty: ProvenancedField<number>;
  calibrationStatus: CalibrationStatus;
  calibrationSampleSize: ProvenancedField<number>;

  regime: ProvenancedField<string>;

  estimatedTransactionCostBps: ProvenancedField<number>;
  netExpectedReturn: ProvenancedField<number>;
  /** Mirrors the existing `organicPaper`/execution-quality convention of an explicit quality label
   *  rather than a fabricated number when cost evidence is insufficient. */
  costQuality: 'MEASURED' | 'INSUFFICIENT_EVIDENCE' | 'NOT_APPLICABLE';
  /** True only when `netExpectedReturn` is a REAL_VALUE or DERIVED (not null) - a convenience flag
   *  so a consumer doesn't have to re-check the provenance label itself just to branch on this. */
  netReturnAvailable: boolean;

  dataFreshness: ProvenancedField<number>; // age in ms of the underlying bar/tick data at eval time
  inputCompleteness: ProvenancedField<number>; // 0-1 fraction of expected inputs actually present

  /** Free-text, human-readable summary of how this evidence object was assembled - never chain-of-
   *  thought, matching the frontend-honesty "safe fields" list in CLAUDE.md § Decision Trace. */
  provenance: string;
}

/** Convenience constructors so every adapter uses the exact same NULL/real shape - avoids a typo
 *  in one adapter silently drifting from another's null-field shape. */
export function realValue<T>(value: T): ProvenancedField<T> {
  return { value, provenance: 'REAL_VALUE' };
}
export function derivedValue<T>(value: T): ProvenancedField<T> {
  return { value, provenance: 'DERIVED' };
}
export function notSupported<T>(): ProvenancedField<T> {
  return { value: null, provenance: 'NULL_NOT_SUPPORTED' };
}
export function notYetCalibrated<T>(): ProvenancedField<T> {
  return { value: null, provenance: 'NOT_YET_CALIBRATED' };
}
