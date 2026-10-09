/**
 * QuantExecutionPolicy — the deterministic approval layer for validated quant strategies
 * (Quant-First Decision Architecture, 2026-10-07).
 *
 * Answers ONE question: "Is this quantitative signal authorized and internally valid enough
 * to be submitted to the existing safety/risk spine?" It is NOT a second RiskEngine, NOT a
 * second OMS path, and NOT a consensus replacement. Every approval still flows through the
 * single canonical spine: ChiefTrader (this policy's caller) -> CHIEF_APPROVED_IDEA ->
 * RiskAgent -> RiskEngine (all 26 gates) -> PositionSizing -> OMS -> BrokerManager.
 *
 * HARD INVARIANTS (enforced by architecture tests, not just comments):
 *  - Never calls an LLM. Never imports AIRouter, any LLM client, ConsensusDebate,
 *    BullResearcher, BearResearcher, or any provider module. AI can be entirely absent and
 *    this policy functions identically (AI availability is neutral, never negative evidence).
 *  - Never imports BrokerManager, OrderManagement (OMS), RiskEngine, ChiefTraderAgent, or
 *    EventBus. It produces a decision object; ChiefTraderAgent performs the canonical
 *    approval emission. No second order path can exist here by construction.
 *  - Never invents quant math: reuses ExpectedValue.riskRewardRatio, ConfidenceCalibration's
 *    bucketing/sufficiency, StrategyEngine's regime predicate, and the emitter-attached
 *    internalEnsemble / dataQuality snapshots. EV gating itself stays at emission
 *    (QuantSignalAgent's real live-win-rate check) - this policy re-verifies that risk is
 *    defined and R:R adequate rather than computing a second, worse EV estimate.
 *  - AI contradiction analysis (quantDetail.aiContradictionAnalysis) is advisory ONLY. It is
 *    recorded in the decision metadata and never gates approval: a failed Ollama server is
 *    never a hidden kill switch for quant.
 *
 * Check structure (Phase 6 — quantitative independence, done honestly):
 *  - REQUIRED: every check must pass. Each is a validity condition on this specific signal
 *    (authority, well-formedness, real trigger, defined risk, fresh data).
 *  - SUPPORT: independent quantitative dimensions from genuinely different evidence sources
 *    (market-regime model, cross-strategy correlation-adjusted ensemble, historical
 *    calibration, payoff asymmetry). At least minQuantSupportDimensions must hold.
 *    Correlated indicators inside one strategy (RSI+MACD+momentum) count ONCE, via the
 *    strategy's own trigger (REQUIRED), never as multiple support dimensions.
 *
 * Control-plane code (same category as ChiefTraderAgent itself): composes existing canonical
 * functions. Contains no new indicator/strategy/signal calculations (Java 26 Engine Authority).
 */
import { riskRewardRatio, levelsAreDirectionallyConsistent } from './risk/ExpectedValue';
import { bucketFor, isCalibrationSampleSufficient } from '../services/ConfidenceCalibration';
import { tradingSafety } from '../config/tradingSafety';
import { deskIntelligence } from '../config/deskIntelligence';
import { minQuantSupportDimensions } from '../config/quantDecisionPolicy';
import { eq, and } from 'drizzle-orm';
import type { StrategyEvaluation } from './strategies/types';
import type {
  QuantStrategyAuthorization,
} from './QuantStrategyAuthorization';
// NOTE: the database is imported lazily inside defaultCalibrationLookup() — this module must
// never pay import-time migration cost, and unit tests inject their own calibration lookup.

export interface QuantPolicyIdeaInput {
  traceId?: unknown;
  symbol?: unknown;
  side?: unknown;
  confidence?: unknown;
  reasoning?: unknown;
  agent?: unknown;
  currentPrice?: unknown;
  strategyId?: unknown;
  origin?: unknown;
  expiresAt?: unknown;
  quantDetail?: {
    strategyEvaluation?: StrategyEvaluation | null;
    regime?: { regime?: unknown } | null;
    internalEnsemble?: {
      rawSide?: unknown;
      sideMismatch?: unknown;
      qualifiesAsIndependent?: unknown;
    } | null;
    dataQuality?: { tradeBlocked?: unknown; blockReason?: unknown } | null;
    aiContradictionAnalysis?: { available?: unknown; aiAgreesWithSide?: unknown } | null;
  } | null;
  /**
   * Advisory-only note from AiAdvisoryService (2026-10-07, Phase-40 AI value channel).
   * Recorded on the decision for operator context; never consulted by any check,
   * never gates approval. Absent/null for every caller that does not pass one.
   */
  aiAdvisoryNote?: string | null;
}

export interface QuantPolicyCheckResult {
  id: string;
  category: 'REQUIRED' | 'SUPPORT';
  passed: boolean;
  detail: string;
}

export type QuantPolicyReasonCode =
  | 'QUANT_POLICY_APPROVED'
  | 'QUANT_POLICY_ERROR'
  | 'QUANT_AUTHORITY_INVALID'
  | 'QUANT_SIDE_INVALID'
  | 'QUANT_NUMERIC_INVALID'
  | 'QUANT_NO_STRATEGY_EVALUATION'
  | 'QUANT_STRATEGY_MISMATCH'
  | 'QUANT_SIDE_MISMATCH'
  | 'QUANT_TRIGGER_NOT_FIRED'
  | 'QUANT_RISK_UNDEFINED'
  | 'QUANT_DATA_BLOCKED'
  | 'QUANT_SIGNAL_EXPIRED'
  | 'QUANT_INSUFFICIENT_SUPPORT';

export interface QuantPolicyDecision {
  approved: boolean;
  /** Always 'QUANT_EXECUTION' — never faked as a consensus tier. */
  decisionPolicy: 'QUANT_EXECUTION';
  reasonCode: QuantPolicyReasonCode;
  reason: string;
  authorization: QuantStrategyAuthorization;
  checks: QuantPolicyCheckResult[];
  supportSatisfied: number;
  supportRequired: number;
  /** Real R:R from the strategy's own stop/target, or null when risk is undefined. */
  riskRewardRatio: number | null;
  /** The strategy's own confidence — explicitly NOT a consensus confidence. */
  strategyConfidence: number | null;
  /** Explicit null: consensus was not run for this decision. Never fabricated. */
  consensusConfidence: null;
  /** Explicit: AI providers were not consulted; their availability is neutral here. */
  aiAvailability: 'NOT_CONSULTED';
  /** AI contradiction review, if present on the idea — advisory only, never gating. */
  aiAdvisoryNote: string | null;
  evaluatedAt: string;
  durationMs: number;
}

export interface QuantPolicyOptions {
  /**
   * Injected calibration lookup for tests. Production default reads the canonical
   * agentConfidenceCalibration table exactly the way ChiefTraderAgent does.
   */
  calibrationLookup?: (
    agent: string,
    confidence: number,
  ) => Promise<{ sufficient: boolean; sampleSize: number } | null>;
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

async function defaultCalibrationLookup(
  agent: string,
  confidence: number,
): Promise<{ sufficient: boolean; sampleSize: number } | null> {
  try {
    // Lazy: importing '../db' at module top level would run migrations on import.
    const { db } = await import('../db');
    const { agentConfidenceCalibration } = await import('../db/schema');
    const bucket = bucketFor(confidence);
    const rows = await db
      .select()
      .from(agentConfidenceCalibration)
      .where(
        and(
          eq(agentConfidenceCalibration.agentName, agent),
          eq(agentConfidenceCalibration.bucketLow, bucket.low),
        ),
      );
    const row = rows[0];
    if (!row) return null;
    const sampleSize = row.wins + row.losses;
    return {
      sufficient: isCalibrationSampleSufficient(row.wins, row.losses, tradingSafety.minCalibrationSampleSize),
      sampleSize,
    };
  } catch {
    // Calibration is a SUPPORT dimension, never required: a lookup failure simply does not
    // satisfy the dimension. Never throws into the policy.
    return null;
  }
}

function req(id: string, passed: boolean, detail: string): QuantPolicyCheckResult {
  return { id, category: 'REQUIRED', passed, detail };
}

function sup(id: string, passed: boolean, detail: string): QuantPolicyCheckResult {
  return { id, category: 'SUPPORT', passed, detail };
}

/**
 * Deterministic evaluation. No I/O except the (injectable) calibration lookup and no
 * network calls. Pure function of (idea, authorization) otherwise.
 */
export async function evaluateQuantExecutionPolicy(
  idea: QuantPolicyIdeaInput,
  authorization: QuantStrategyAuthorization,
  opts: QuantPolicyOptions = {},
): Promise<QuantPolicyDecision> {
  const startMs = Date.now();
  const checks: QuantPolicyCheckResult[] = [];
  // Hoisted: early fail() paths run before the RISK_DEFINED check below computes these.
  let rrRatio: number | null = null;
  let aiAdvisoryNote: string | null = null;
  const fail = (
    reasonCode: QuantPolicyReasonCode,
    reason: string,
  ): QuantPolicyDecision => finalize(false, reasonCode, reason);

  const finalize = (
    approved: boolean,
    reasonCode: QuantPolicyReasonCode,
    reason: string,
  ): QuantPolicyDecision => {
    const support = checks.filter((c) => c.category === 'SUPPORT' && c.passed).length;
    return {
      approved,
      decisionPolicy: 'QUANT_EXECUTION',
      reasonCode,
      reason,
      authorization,
      checks,
      supportSatisfied: support,
      supportRequired: minQuantSupportDimensions(),
      riskRewardRatio: rrRatio,
      strategyConfidence: isFiniteNumber(idea?.confidence) ? (idea.confidence as number) : null,
      consensusConfidence: null,
      aiAvailability: 'NOT_CONSULTED',
      aiAdvisoryNote,
      evaluatedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
    };
  };

  // ---- REQUIRED: authority (the resolver already verified; re-asserted, never re-derived) ----
  const authorityOk = authorization?.authority === 'AUTHORIZED_QUANT_POLICY';
  checks.push(
    req(
      'AUTHORITY_VALID',
      authorityOk,
      authorityOk
        ? `Central authorization: ${authorization.reason} (strategy ${authorization.strategyId}, lifecycle ${authorization.lifecycleStatus})`
        : `Not authorized for quant execution: ${authorization?.reason ?? 'no authorization'}`,
    ),
  );
  if (!authorityOk) {
    return fail('QUANT_AUTHORITY_INVALID', `Quant policy requires AUTHORIZED_QUANT_POLICY; got ${authorization?.authority} (${authorization?.reason}).`);
  }

  // ---- REQUIRED: side ----
  const side = idea?.side;
  const sideOk = side === 'BUY' || side === 'SELL';
  checks.push(req('SIDE_VALID', sideOk, sideOk ? `side=${side}` : `side must be BUY/SELL, got ${String(side)}`));
  if (!sideOk) return fail('QUANT_SIDE_INVALID', `Invalid side: ${String(side)}.`);

  // ---- REQUIRED: numeric sanity ----
  const confidence = idea?.confidence;
  const currentPrice = idea?.currentPrice;
  const numericOk =
    isFiniteNumber(confidence) && (confidence as number) > 0 && (confidence as number) <= 1 &&
    isFiniteNumber(currentPrice) && (currentPrice as number) > 0;
  checks.push(
    req(
      'NUMERIC_SANITY',
      numericOk,
      numericOk
        ? `confidence=${(confidence as number).toFixed(3)} currentPrice=${currentPrice}`
        : 'confidence must be a finite number in (0,1] and currentPrice a finite positive number (no NaN/Infinity)',
    ),
  );
  if (!numericOk) return fail('QUANT_NUMERIC_INVALID', 'Non-finite or out-of-range confidence/currentPrice.');

  // ---- REQUIRED: a real strategy evaluation backs this idea ----
  const evaluation = idea?.quantDetail?.strategyEvaluation ?? null;
  const evalPresent = !!evaluation && typeof evaluation === 'object';
  checks.push(
    req(
      'EVALUATION_PRESENT',
      evalPresent,
      evalPresent
        ? `strategyEvaluation present for ${evaluation.strategy}`
        : 'No strategyEvaluation on the idea (e.g. cold-start bootstrap ideas carry no evaluation and cannot use the quant path)',
    ),
  );
  if (!evalPresent || !evaluation) {
    return fail('QUANT_NO_STRATEGY_EVALUATION', 'Quant execution requires a real strategy evaluation on the idea.');
  }

  // ---- REQUIRED: the evaluation actually backs the claimed strategy and side ----
  const strategyMatch = evaluation.strategy === authorization.strategyId;
  checks.push(
    req(
      'STRATEGY_MATCH',
      strategyMatch,
      strategyMatch
        ? `evaluation.strategy=${evaluation.strategy} matches authorized ${authorization.strategyId}`
        : `evaluation.strategy=${evaluation.strategy} does not match authorized strategyId=${authorization.strategyId} (stale/mismatched evaluation)`,
    ),
  );
  if (!strategyMatch) return fail('QUANT_STRATEGY_MISMATCH', 'Strategy evaluation does not match the authorized strategy.');

  const sideMatch = evaluation.side === side;
  checks.push(
    req(
      'SIDE_MATCH',
      sideMatch,
      sideMatch
        ? `evaluation.side=${evaluation.side} matches idea side`
        : `evaluation.side=${evaluation.side} disagrees with idea side=${side}`,
    ),
  );
  if (!sideMatch) return fail('QUANT_SIDE_MISMATCH', 'Strategy evaluation side disagrees with the idea side.');

  // ---- REQUIRED: the defining trigger actually fired ----
  // Canonical gate concept (StrategyEngine.applyTriggerGate): the trigger is what makes an
  // evaluation this strategy's setup. Confirming conditions must never outvote a missing trigger.
  const triggerMet = evaluation.triggerMet === true;
  checks.push(
    req(
      'TRIGGER_FIRED',
      triggerMet,
      triggerMet
        ? `triggerMet=true for ${evaluation.strategy} on this bar`
        : 'Defining trigger did not fire — not a real production signal for this strategy',
    ),
  );
  if (!triggerMet) return fail('QUANT_TRIGGER_NOT_FIRED', 'Strategy trigger did not fire; confirming conditions alone never authorize execution.');

  // ---- REQUIRED: risk is really defined (reuses ExpectedValue.riskRewardRatio) ----
  // 2026-10-07 (strategy-layer audit D3): riskRewardRatio() is direction-agnostic (measures
  // |distances| only), so a strategy bug emitting an inverted stop/target pair still yields a
  // positive "valid" ratio. levelsAreDirectionallyConsistent() closes that hole: BUY requires
  // stop < entry < target, SELL mirrored, strict. Directionally-inconsistent levels fail here
  // as QUANT_RISK_UNDEFINED - a data defect, never a real R:R. No threshold changed.
  const stopPrice = evaluation.stop?.price;
  const targetPrice = evaluation.target?.price;
  // SIDE_VALID above already fail-closed on anything but BUY/SELL; the cast below is honest,
  // and levelsAreDirectionallyConsistent() itself still returns false for a non-BUY/SELL side.
  const levelsConsistent = levelsAreDirectionallyConsistent(side as 'BUY' | 'SELL', currentPrice as number, stopPrice as number, targetPrice as number);
  const rr = isFiniteNumber(stopPrice) && isFiniteNumber(targetPrice) && levelsConsistent
    ? riskRewardRatio(currentPrice as number, stopPrice, targetPrice)
    : null;
  rrRatio = rr?.ratio ?? null;
  const riskOk = rr !== null && rrRatio !== null && Number.isFinite(rrRatio) && rrRatio > 0;
  checks.push(
    req(
      'RISK_DEFINED',
      riskOk,
      riskOk
        ? `R:R=${(rrRatio as number).toFixed(2)} (stop=${stopPrice} target=${targetPrice} entry=${currentPrice})`
        : 'No usable stop/target risk-reward: stop equals entry, stop/target missing/non-finite, or stop/target on the wrong side of entry for this side (directionally inconsistent)',
    ),
  );
  if (!riskOk) return fail('QUANT_RISK_UNDEFINED', 'Risk is undefined (missing stop/target, stop == entry, or stop/target directionally inconsistent with the idea side). No trade without defined risk.');

  // ---- REQUIRED: canonical data-quality snapshot does not block ----
  // Reuses the emitter-attached DataQualitySnapshot (assessDataQuality). Absent snapshot is
  // noted but not fatal here: RiskEngine's own data_freshness gate remains the safety owner.
  const dq = idea?.quantDetail?.dataQuality;
  const dataBlocked = dq != null && (dq as { tradeBlocked?: unknown }).tradeBlocked === true;
  checks.push(
    req(
      'DATA_NOT_BLOCKED',
      !dataBlocked,
      dataBlocked
        ? `dataQuality.tradeBlocked: ${(dq as { blockReason?: unknown }).blockReason ?? 'no reason'}`
        : dq != null
          ? 'dataQuality snapshot present, not blocked'
          : 'no dataQuality snapshot attached (noted; RiskEngine data_freshness gate still applies)',
    ),
  );
  if (dataBlocked) return fail('QUANT_DATA_BLOCKED', `Canonical data-quality snapshot blocks trading: ${(dq as { blockReason?: unknown }).blockReason ?? 'stale/unavailable data'}.`);

  // ---- REQUIRED: explicit signal expiry respected ----
  // 2026-10-08 defect hunt (P2): malformed expiresAt is fail-CLOSED. Previously
  // new Date(malformed).getTime() yielded NaN, and NaN <= Date.now() is false,
  // so a garbage expiry string was treated as "not expired" — fail-open. An
  // idea that claims an expiry must carry a parseable one; otherwise it is
  // rejected as expired. (The documented quantPolicySignalMaxAgeMs bound remains
  // defense-in-depth for a future async path: ideas are evaluated synchronously
  // at receipt today, so no emission timestamp exists to bound against.)
  const expiresAt = idea?.expiresAt;
  const expiresAtMs = expiresAt != null && expiresAt !== '' ? new Date(String(expiresAt)).getTime() : NaN;
  const expired = expiresAt != null && expiresAt !== '' && (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now());
  checks.push(
    req('NOT_EXPIRED', !expired, expired ? `signal expired at ${String(expiresAt)}` : 'signal not expired'),
  );
  if (expired) return fail('QUANT_SIGNAL_EXPIRED', 'Signal is past its explicit expiry (or carries an unparseable expiry); no longer actionable.');

  // ---- AI advisory: recorded, never gating (veto/advice split) ----
  // The AiAdvisoryService note (2026-10-07) arrives as an optional idea input; it is
  // recorded here and never consulted by any REQUIRED/SUPPORT check below.
  const ideaAdvisoryNote =
    typeof idea?.aiAdvisoryNote === 'string' && idea.aiAdvisoryNote.trim() !== ''
      ? idea.aiAdvisoryNote
      : null;
  const aiReview = idea?.quantDetail?.aiContradictionAnalysis;
  aiAdvisoryNote =
    ideaAdvisoryNote ??
    (aiReview && (aiReview as { available?: unknown }).available === true
      ? `AI contradiction review present (agreesWithSide=${String((aiReview as { aiAgreesWithSide?: unknown }).aiAgreesWithSide)}): advisory only, not a veto.`
      : null);

  // ---- SUPPORT: independent quantitative dimensions (need >= minQuantSupportDimensions) ----
  // S1 — regime compatibility: the market-regime model is a different computation from the
  // entry trigger. Same canonical predicate StrategyEngine.regimeStrategyEligibility uses.
  const regimeName = idea?.quantDetail?.regime?.regime;
  const regimeOk =
    typeof regimeName === 'string' &&
    Array.isArray(evaluation.applicableRegimes) &&
    evaluation.applicableRegimes.includes(regimeName as never);
  checks.push(
    sup(
      'REGIME_COMPATIBLE',
      regimeOk,
      regimeOk
        ? `regime ${regimeName} within strategy applicableRegimes`
        : `regime ${String(regimeName)} not in [${(evaluation.applicableRegimes ?? []).join(', ')}] or regime unknown`,
    ),
  );

  // S2 — ensemble confluence: the correlation-adjusted internal ensemble (QuantEnsembleEngine
  // math via internalQuantEnsemble) independently resolves to the same side. Reused as-is,
  // never recomputed; sideMismatch explicitly disqualifies.
  const ensemble = idea?.quantDetail?.internalEnsemble;
  const ensembleOk =
    !!ensemble && ensemble.rawSide === side && ensemble.sideMismatch !== true;
  checks.push(
    sup(
      'ENSEMBLE_CONFLUENCE',
      ensembleOk,
      ensembleOk
        ? `internal ensemble rawSide=${String(ensemble.rawSide)} agrees, no sideMismatch`
        : 'internal ensemble absent, disagreeing, or sideMismatch',
    ),
  );

  // S3 — calibration support: this producer's stated confidence bucket has a real,
  // sufficiently-sampled calibration history (ConfidenceCalibration bucketing + sufficiency,
  // same canonical table ChiefTrader reads). Historical reliability, independent of today's signal.
  let calibrationOk = false;
  let calibrationDetail = 'calibration lookup unavailable';
  try {
    const lookup = opts.calibrationLookup ?? defaultCalibrationLookup;
    const agent = typeof idea?.agent === 'string' ? (idea.agent as string) : '';
    const cal = agent ? await lookup(agent, confidence as number) : null;
    calibrationOk = cal?.sufficient === true;
    calibrationDetail = cal
      ? `calibration sample=${cal.sampleSize} sufficient=${cal.sufficient}`
      : 'no calibration history for this agent/bucket';
  } catch {
    calibrationDetail = 'calibration lookup failed (does not satisfy dimension)';
  }
  checks.push(sup('CALIBRATION_SUPPORTED', calibrationOk, calibrationDetail));

  // S4 — risk/reward adequacy: the canonical desk minimum (config/deskIntelligence.json,
  // the same number QuantSignalAgent enforces at emission) re-verified at decision time.
  // Payoff asymmetry is independent of trigger, regime, and history.
  const rrAdequate = (rrRatio as number) >= deskIntelligence.minRiskRewardRatio;
  checks.push(
    sup(
      'RISK_REWARD_ADEQUATE',
      rrAdequate,
      rrAdequate
        ? `R:R ${(rrRatio as number).toFixed(2)} >= desk min ${deskIntelligence.minRiskRewardRatio}`
        : `R:R ${(rrRatio as number).toFixed(2)} < desk min ${deskIntelligence.minRiskRewardRatio}`,
    ),
  );

  const satisfied = checks.filter((c) => c.category === 'SUPPORT' && c.passed).length;
  const required = minQuantSupportDimensions();
  if (satisfied < required) {
    return fail(
      'QUANT_INSUFFICIENT_SUPPORT',
      `Only ${satisfied}/${checks.filter((c) => c.category === 'SUPPORT').length} independent quantitative support dimensions satisfied (need ${required}): ` +
        checks.filter((c) => c.category === 'SUPPORT' && !c.passed).map((c) => c.id).join(', ') +
        '.',
    );
  }

  return finalize(
    true,
    'QUANT_POLICY_APPROVED',
    `Quant policy approved: ${authorization.strategyId} ${side} (lifecycle ${authorization.lifecycleStatus}, ` +
      `trigger fired, R:R ${(rrRatio as number).toFixed(2)}, ${satisfied} independent support dimensions). ` +
      `Consensus not run; AI not consulted. Forwarding to RiskEngine unchanged.`,
  );
}
