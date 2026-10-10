/**
 * Lifecycle Certification Bridge (2026-10-09, Priority 3).
 *
 * THE MISSING LINK, MADE EXPLICIT. The Oct-9 forensic found 755 NO_LIFECYCLE_RECORD
 * authorization events and 0 privileged PAPER Quant strategies, and the Layer-3 probe
 * (productionStateCertification.test.ts) confirmed LIFECYCLE_PROMOTION_ROUTE=ABSENT: no
 * production code path ever recorded a VALIDATED/CHAMPION lifecycle decision into
 * learning_versions, even though the research side (promotionEngine) could derive a
 * research-vocabulary VALIDATED from evidence. The full chain as it exists:
 *
 *   research evidence (quant_strategy_backtests, research runs, organic paper fills)
 *     -> evidence accumulation (StrategyEvidence booleans, coreRobustness gates)
 *     -> promotionEngine.deriveLifecycleStatus()          [research-side vocabulary; read-only reports only]
 *     -> ???  <-- THE ABSENT LINK: no operator/review decision point existed
 *     -> recordStrategyLifecycleTransition()              [exists; only RETIRED/ROLLED_BACK had production callers]
 *     -> strategyEligibility (getStrategyLifecycleStatus)  [exists; reads latest learning_versions row]
 *     -> QuantStrategyAuthorization                        [exists; VALIDATED/CHAMPION record => AUTHORIZED_QUANT_POLICY]
 *     -> QuantExecutionPolicy                              [exists]
 *
 * This module IS the ??? link: a deliberate, evidence-gated, operator-reviewed workflow
 * that turns research evidence into a runtime lifecycle decision. It NEVER promotes
 * anything on its own, NEVER seeds authority, and NEVER lowers a threshold.
 *
 * STRUCTURAL GUARANTEES (all tested in certificationBridge.test.ts):
 *
 *  1. ASSESSMENT CANNOT WRITE. evaluateCertification() is pure over its inputs: it reads
 *     config thresholds and returns an assessment. The ONLY call site of
 *     recordStrategyLifecycleTransition in this module is inside
 *     executeCertificationTransition(), and a static test asserts that stays exactly one.
 *  2. REVIEW CANNOT BE SKIPPED. executeCertificationTransition() accepts ONLY the branded
 *     ReviewedCertification type, which can only be minted by applyOperatorReview() after
 *     runtime validation of reviewer identity, timestamp, statement, and target/status
 *     agreement. The brand is re-validated at execution (defense in depth against casts).
 *  3. EVIDENCE CANNOT BE WEAK. Sample-sufficiency gates reuse config/researchSafety.json
 *     minimums (never hardcoded here): backtest/OOS need >= minOosTrades closed trades,
 *     walk-forward needs >= minWalkForwardWindows windows, paper needs the full
 *     minPaperTrades/minPaperSessions/minPaperCalendarDays/profit-factor/expectancy/
 *     drawdown set. A "pass" on an insufficient sample counts as a FAIL.
 *  4. TERMINAL STATES STAY TERMINAL. Retired/degraded evidence, or a current
 *     RETIRED/DEGRADED runtime status, refuses every bridge transition; reversal goes
 *     through the existing explicit reinstatement path (reinstateStrategyForEmission ->
 *     ROLLED_BACK), never this workflow.
 *  5. LIVE AUTHORITY IS INEXPRESSIBLE. The bridge's target vocabulary is a closed set of
 *     runtime statuses (UNTESTED/SHADOW/CANDIDATE/ACTIVE_EXPLORATION/VALIDATED/CHAMPION);
 *     the research-side LIVE_CANDIDATE/LIVE_APPROVED vocabulary cannot be named here, and
 *     the runtime gate rejects anything outside the closed set. Even a recorded VALIDATED
 *     row grants nothing outside the paper-only env lock (QuantStrategyAuthorization).
 *  6. CHAMPION IS COMPARATIVE. CHAMPION requires the full VALIDATED gate set PLUS a
 *     current runtime status of VALIDATED: it promotes an already-validated strategy to
 *     "proven current best", never a first-time qualification.
 *
 * VOCABULARY NOTE: promotionEngine's VALIDATED ("paper + backtest + OOS + walk-forward +
 * robustness") is a research-side derivation. This bridge's VALIDATED is the runtime
 * lifecycle decision the authorization layer reads. The bridge deliberately re-checks the
 * research gates itself (it does not trust a derived label) and then adds the two things
 * the research side never had: sample-sufficiency enforcement and the unskippable operator
 * review. The two vocabularies agree on VALIDATED's meaning by construction, but the
 * bridge's decision is the only one that carries execution authority.
 *
 * Control-plane code (same category as QuantStrategyAuthorization): performs lookups,
 * evaluates gates, and records one audited transition. Contains no quant/indicator/
 * strategy calculations (Java 26 Engine Authority) and never imports BrokerManager /
 * OrderManagement / RiskEngine / ChiefTraderAgent / EventBus / AIRouter.
 */
import {
  getStrategyLifecycleStatus,
  recordStrategyLifecycleTransition,
  type StrategyLifecycleStatus,
} from '../quant/strategies/StrategyEmissionEligibility';
import { findStrategy } from '../quant/strategies/StrategyEngine';
import { isTheoreticalZeroCost, researchSafety } from '../config/researchSafety';
import {
  CANONICAL_PROMOTION_FILL,
  isCanonicalPromotionFill,
} from '../research/executionModel';
import {
  assertPromotionQuarantine,
  type StrategyEvidence,
} from '../research/promotionEngine';

/** Module identity stamped into every recorded transition's evidence payload. */
export const CERTIFICATION_BRIDGE_VERSION = 'certification-bridge/1.0.0-2026-10-09';

/**
 * Runtime lifecycle statuses this bridge may record. DEGRADED/RETIRED are excluded:
 * exposure removal has its own existing, evidence-backed operator path
 * (quarantineStrategyForEmission). ROLLED_BACK is excluded: reversal of a terminal
 * decision goes through reinstateStrategyForEmission. The research-side
 * LIVE_CANDIDATE/LIVE_APPROVED vocabulary is deliberately inexpressible here.
 */
export type BridgeTargetStatus = Exclude<
  StrategyLifecycleStatus,
  'DEGRADED' | 'RETIRED' | 'ROLLED_BACK'
>;

const BRIDGE_TARGETS: ReadonlySet<string> = new Set([
  'UNTESTED',
  'SHADOW',
  'CANDIDATE',
  'ACTIVE_EXPLORATION',
  'VALIDATED',
  'CHAMPION',
]);

/** Sample evidence the operator assembles alongside the research booleans. */
export interface CertificationSamples {
  /** Closed trades behind the qualifying backtest result. */
  backtestTrades: number;
  /** Closed trades in the out-of-sample segment. */
  oosTrades: number;
  /** Number of walk-forward windows evaluated. */
  walkForwardWindows: number;
}

/** Provenance for the certification package: which artifacts, what scope, what build. */
export interface CertificationProvenance {
  /** IDs of the research artifacts (backtest run ids, research run ids, paper session ids). */
  evidenceIds: string[];
  /** What the evidence covers, e.g. "canonical NEXT_BAR_OPEN backtests, REAL_MARKET_DATA, 2020-2025". */
  evidenceScope: string;
  /** Code build/version that produced the evidence. */
  buildVersion: string;
}

export interface CertificationGateResult {
  gate: string;
  pass: boolean;
  detail: string;
}

export type EligibleTarget = BridgeTargetStatus | 'NONE';

export interface CertificationAssessment {
  strategyId: string;
  /** The highest runtime status the evidence supports. 'NONE' when failClosed. */
  eligibleTarget: EligibleTarget;
  /** True when NO bridge transition is permitted at all (terminal/unknown/retired). */
  failClosed: boolean;
  reason: string;
  gates: CertificationGateResult[];
  samples: CertificationSamples;
  provenance: CertificationProvenance;
  assessedAt: string;
}

/**
 * The unskippable human decision. Every field is validated by applyOperatorReview():
 * reviewer must be a real identity, decidedAt a sane timestamp, statement a real
 * rationale, and targetStatus must equal the assessment's eligibleTarget (the operator
 * may NOT approve a status the evidence does not support).
 */
export interface OperatorReview {
  reviewer: string;
  decidedAt: string;
  statement: string;
  targetStatus: BridgeTargetStatus;
}

/**
 * Module-private brand token. A real runtime symbol (not a type-only declaration):
 * applyOperatorReview() is the only code that can stamp it, and validateReviewedCertification()
 * checks it at runtime, so a plain cast object can never pass as reviewed.
 */
const BRIDGE_REVIEW_BRAND: unique symbol = Symbol('argus.certificationBridge.operatorReviewed');

/**
 * A certification that has passed the operator-review gate. The brand can only be minted
 * by applyOperatorReview(); executeCertificationTransition() accepts nothing else.
 * This is the TYPE-LEVEL half of "review cannot be skipped".
 */
export interface ReviewedCertification {
  readonly [BRIDGE_REVIEW_BRAND]: 'OPERATOR_REVIEWED';
  readonly assessment: CertificationAssessment;
  readonly review: OperatorReview;
}

export interface ExecutedTransition {
  transitionId: string;
  strategyId: string;
  oldStatus: StrategyLifecycleStatus;
  newStatus: BridgeTargetStatus;
}

// ---------------------------------------------------------------------------
// Gate evaluation (pure)
// ---------------------------------------------------------------------------

function gate(gates: CertificationGateResult[], name: string, pass: boolean, detail: string): void {
  gates.push({ gate: name, pass, detail });
}

/**
 * Evaluate research evidence into a certification assessment. PURE: reads config
 * thresholds, touches no database, records nothing. A "pass" on an insufficient
 * sample is treated as a FAIL — sample sufficiency is enforced before any ladder
 * rung is considered.
 */
export function evaluateCertification(
  strategyId: string,
  evidence: StrategyEvidence,
  samples: CertificationSamples,
  provenance: CertificationProvenance,
  now: Date = new Date(),
): CertificationAssessment {
  const gates: CertificationGateResult[] = [];
  const minSampleTrades = researchSafety.minOosTrades;
  const minWfWindows = researchSafety.minWalkForwardWindows;

  // --- Strategy must be real (no invented ids) ---
  const known = typeof strategyId === 'string' && strategyId.trim() !== '' && findStrategy(strategyId.trim()) !== undefined;
  gate(gates, 'STRATEGY_KNOWN', known, known ? 'strategyId resolves in the canonical registry' : 'unknown or empty strategyId');
  if (!known) {
    return failClosed(strategyId, gates, samples, provenance, now, 'unknown strategyId: no transition permitted');
  }

  // --- Terminal evidence: retired/degraded evidence can never promote via this bridge ---
  const retiredEvidence = evidence.retired === true;
  const degradedEvidence = evidence.degraded === true;
  gate(gates, 'EVIDENCE_NOT_RETIRED', !retiredEvidence, retiredEvidence ? 'research evidence marks the strategy retired' : 'not retired');
  gate(gates, 'EVIDENCE_NOT_DEGRADED', !degradedEvidence, degradedEvidence ? 'research evidence marks the strategy degraded' : 'not degraded');
  if (retiredEvidence || degradedEvidence) {
    return failClosed(
      strategyId, gates, samples, provenance, now,
      'terminal research evidence (retired/degraded): promotion refused; reversal requires the explicit reinstatement path',
    );
  }

  // --- Promotion quarantine (mirrors promotionEngine.assertPromotionQuarantine + deriveLifecycleStatus guards) ---
  const quarantine = assertPromotionQuarantine({
    executionModel: evidence.executionModel,
    qualityStatus: evidence.qualityStatus,
    parquetBytesWritten: evidence.parquetBytesWritten,
  });
  const canonicalFill = isCanonicalPromotionFill(evidence.executionModel);
  gate(gates, 'EXECUTION_MODEL_CANONICAL', canonicalFill, `executionModel=${evidence.executionModel}, canonical=${CANONICAL_PROMOTION_FILL}`);
  gate(gates, 'EVIDENCE_QUALITY_GREEN', evidence.qualityStatus === 'GREEN', `qualityStatus=${evidence.qualityStatus}`);
  gate(gates, 'PARQUET_BYTES_WRITTEN', evidence.parquetBytesWritten === true, 'physical parquet bytes must exist; sidecar flag alone is insufficient');
  gate(gates, 'REAL_MARKET_DATA', evidence.dataProvenance === 'REAL_MARKET_DATA', `dataProvenance=${evidence.dataProvenance}`);
  gate(gates, 'NO_ENGINE_MISMATCH', evidence.engineMismatch !== true, evidence.engineMismatch ? 'engine mismatch: evidence not promotable' : 'no engine mismatch');
  gate(gates, 'NOT_THEORETICAL_ZERO_COST', !isTheoreticalZeroCost(), isTheoreticalZeroCost() ? 'theoretical zero-cost research cannot climb the ladder' : 'real cost model');
  const quarantineOk = quarantine.ok && canonicalFill && evidence.dataProvenance === 'REAL_MARKET_DATA'
    && evidence.engineMismatch !== true && !isTheoreticalZeroCost();

  // --- Sample-sufficiency-gated research rungs (a pass on too few samples is a FAIL) ---
  const backtestN = Math.max(0, Math.floor(samples.backtestTrades));
  const oosN = Math.max(0, Math.floor(samples.oosTrades));
  const wfWindows = Math.max(0, Math.floor(samples.walkForwardWindows));
  const backtestOk = evidence.backtestPass === true && backtestN >= minSampleTrades;
  const oosOk = evidence.oosPass === true && oosN >= minSampleTrades;
  const walkForwardOk = evidence.walkForwardPass === true && wfWindows >= minWfWindows;
  gate(gates, 'BACKTEST_PASS_SUFFICIENT', backtestOk,
    `backtestPass=${evidence.backtestPass}, trades=${backtestN} (min ${minSampleTrades})`);
  gate(gates, 'OOS_PASS_SUFFICIENT', oosOk,
    `oosPass=${evidence.oosPass}, trades=${oosN} (min ${minSampleTrades})`);
  gate(gates, 'WALK_FORWARD_SUFFICIENT', walkForwardOk,
    `walkForwardPass=${evidence.walkForwardPass}, windows=${wfWindows} (min ${minWfWindows})`);

  // --- Robustness (all four, mirroring promotionEngine's VALIDATED condition) ---
  const mc = evidence.monteCarloPass === true;
  const perm = evidence.permutationPass === true;
  const sens = evidence.sensitivityPass === true;
  const cost = evidence.costStressPass === true;
  gate(gates, 'ROBUSTNESS_MONTE_CARLO', mc, `monteCarloPass=${evidence.monteCarloPass}`);
  gate(gates, 'ROBUSTNESS_PERMUTATION', perm, `permutationPass=${evidence.permutationPass}`);
  gate(gates, 'ROBUSTNESS_SENSITIVITY', sens, `sensitivityPass=${evidence.sensitivityPass}`);
  gate(gates, 'ROBUSTNESS_COST_STRESS', cost, `costStressPass=${evidence.costStressPass}`);
  const robustnessOk = mc && perm && sens && cost;

  // --- Paper evidence (organic only; full researchSafety minimum set) ---
  const paperTradesOk = evidence.paperTrades >= researchSafety.minPaperTrades;
  const paperSessionsOk = evidence.paperSessions >= researchSafety.minPaperSessions;
  gate(gates, 'PAPER_TRADES', paperTradesOk, `paperTrades=${evidence.paperTrades} (min ${researchSafety.minPaperTrades})`);
  gate(gates, 'PAPER_SESSIONS', paperSessionsOk, `paperSessions=${evidence.paperSessions} (min ${researchSafety.minPaperSessions})`);
  gate(gates, 'PAPER_CALENDAR_DAYS', evidence.paperCalendarDaysPass === true, `paperCalendarDaysPass=${evidence.paperCalendarDaysPass} (min ${researchSafety.minPaperCalendarDays} distinct NY days)`);
  gate(gates, 'PAPER_EXPECTANCY_POSITIVE', evidence.paperExpectancyPositive === true, `paperExpectancyPositive=${evidence.paperExpectancyPositive}`);
  gate(gates, 'PAPER_DRAWDOWN_WITHIN_LIMIT', evidence.paperDrawdownWithinLimit === true, `paperDrawdownWithinLimit=${evidence.paperDrawdownWithinLimit} (max ${(researchSafety.maxPaperDrawdownPct * 100).toFixed(0)}%)`);
  gate(gates, 'PAPER_PROFIT_FACTOR', evidence.paperProfitFactorPass === true, `paperProfitFactorPass=${evidence.paperProfitFactorPass} (min ${researchSafety.minPaperProfitFactor})`);
  gate(gates, 'PAPER_ORGANIC_ONLY', evidence.organicPaperOnly === true, 'paper evidence must be organic (no replay/backtest/simulation)');
  const paperOk = paperTradesOk && paperSessionsOk && evidence.paperCalendarDaysPass === true
    && evidence.paperExpectancyPositive === true && evidence.paperDrawdownWithinLimit === true
    && evidence.paperProfitFactorPass === true && evidence.organicPaperOnly === true;

  // --- Ladder: the highest rung whose every gate holds ---
  let eligibleTarget: BridgeTargetStatus = 'UNTESTED';
  let reason = 'evidence does not support promotion past an explicit UNTESTED baseline';
  if (quarantineOk && backtestOk && oosOk && walkForwardOk && robustnessOk && paperOk) {
    eligibleTarget = 'VALIDATED';
    reason = 'full gate set holds: quarantine + backtest + OOS + walk-forward + robustness + organic paper evidence';
  } else if (quarantineOk && backtestOk && oosOk && walkForwardOk && robustnessOk) {
    eligibleTarget = 'ACTIVE_EXPLORATION';
    reason = 'research evidence complete; organic paper evidence still accumulating — bounded, monitored exposure via the consensus path while evidence accumulates (never AI-independent authority)';
  } else if (quarantineOk && backtestOk && oosOk) {
    eligibleTarget = 'CANDIDATE';
    reason = 'backtest + OOS pass with sufficient samples; walk-forward not yet demonstrated';
  } else if (quarantineOk && backtestOk) {
    eligibleTarget = 'SHADOW';
    reason = 'backtest passes with sufficient samples; OOS not yet demonstrated';
  }

  return {
    strategyId: strategyId.trim(),
    eligibleTarget,
    failClosed: false,
    reason,
    gates,
    samples: { backtestTrades: backtestN, oosTrades: oosN, walkForwardWindows: wfWindows },
    provenance,
    assessedAt: now.toISOString(),
  };
}

function failClosed(
  strategyId: string,
  gates: CertificationGateResult[],
  samples: CertificationSamples,
  provenance: CertificationProvenance,
  now: Date,
  reason: string,
): CertificationAssessment {
  return {
    strategyId,
    eligibleTarget: 'NONE',
    failClosed: true,
    reason,
    gates,
    samples,
    provenance,
    assessedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Operator review — the unskippable gate (runtime half)
// ---------------------------------------------------------------------------

const MAX_REVIEW_FUTURE_SKEW_MS = 5 * 60 * 1000;

function validateReviewFields(review: OperatorReview): void {
  const reviewer = typeof review?.reviewer === 'string' ? review.reviewer.trim() : '';
  if (reviewer.length < 2) {
    throw new Error('CERTIFICATION_BRIDGE: OPERATOR_REVIEW_REQUIRED — reviewer identity is missing or empty; the review step cannot be skipped');
  }
  const decidedAt = typeof review?.decidedAt === 'string' ? review.decidedAt : '';
  const decidedMs = Date.parse(decidedAt);
  if (!Number.isFinite(decidedMs)) {
    throw new Error('CERTIFICATION_BRIDGE: OPERATOR_REVIEW_REQUIRED — decidedAt is not a valid timestamp');
  }
  if (decidedMs > Date.now() + MAX_REVIEW_FUTURE_SKEW_MS) {
    throw new Error('CERTIFICATION_BRIDGE: OPERATOR_REVIEW_REQUIRED — decidedAt is in the future beyond clock-skew tolerance');
  }
  const statement = typeof review?.statement === 'string' ? review.statement.trim() : '';
  if (statement.length < 10) {
    throw new Error('CERTIFICATION_BRIDGE: OPERATOR_REVIEW_REQUIRED — statement must record a real review rationale (min 10 chars)');
  }
  if (!BRIDGE_TARGETS.has(review.targetStatus)) {
    // LIVE authority is inexpressible: the research-side LIVE_CANDIDATE/LIVE_APPROVED
    // vocabulary is not in BRIDGE_TARGETS, and neither is any other invented status.
    throw new Error(`CERTIFICATION_BRIDGE: INVALID_TARGET — '${String(review.targetStatus)}' is not a bridge-recordable lifecycle status; LIVE authority cannot be produced here`);
  }
}

/**
 * Apply the operator review to a qualified assessment. Mints the branded
 * ReviewedCertification — the ONLY value executeCertificationTransition() accepts.
 * Throws (fail-closed) when: the assessment is fail-closed, the review fields are
 * incomplete, or the operator tries to approve a status the evidence does not support.
 */
export function applyOperatorReview(
  assessment: CertificationAssessment,
  review: OperatorReview,
): ReviewedCertification {
  if (!assessment || assessment.failClosed || assessment.eligibleTarget === 'NONE') {
    throw new Error(`CERTIFICATION_BRIDGE: NOT_QUALIFIED — no transition is permitted (${assessment?.reason ?? 'missing assessment'})`);
  }
  validateReviewFields(review);
  if (review.targetStatus !== assessment.eligibleTarget) {
    throw new Error(
      `CERTIFICATION_BRIDGE: TARGET_MISMATCH — operator approved '${review.targetStatus}' but evidence supports '${assessment.eligibleTarget}'; the operator may not approve a status the evidence does not support`,
    );
  }
  return {
    [BRIDGE_REVIEW_BRAND]: 'OPERATOR_REVIEWED',
    assessment,
    review: {
      reviewer: review.reviewer.trim(),
      decidedAt: review.decidedAt,
      statement: review.statement.trim(),
      targetStatus: review.targetStatus,
    },
  };
}

/**
 * Runtime validator for a ReviewedCertification. Defense in depth: even if a caller
 * casts a plain object to ReviewedCertification, execution re-checks the brand and
 * every review field before touching the database.
 */
export function validateReviewedCertification(reviewed: unknown): asserts reviewed is ReviewedCertification {
  const r = reviewed as Partial<ReviewedCertification> | null | undefined;
  if (!r || typeof r !== 'object' || r[BRIDGE_REVIEW_BRAND] !== 'OPERATOR_REVIEWED') {
    throw new Error('CERTIFICATION_BRIDGE: NOT_REVIEWED — no valid operator review; the review step cannot be skipped or forged');
  }
  validateReviewFields(r.review as OperatorReview);
  const target = r.review!.targetStatus;
  const eligible = r.assessment?.eligibleTarget;
  if (r.assessment?.failClosed || eligible === 'NONE') {
    throw new Error('CERTIFICATION_BRIDGE: NOT_QUALIFIED — the assessment permits no transition');
  }
  if (target !== eligible) {
    throw new Error(`CERTIFICATION_BRIDGE: TARGET_MISMATCH — review target '${target}' does not match assessed '${eligible}'`);
  }
}

// ---------------------------------------------------------------------------
// Execution — the single write path
// ---------------------------------------------------------------------------

/**
 * Execute the reviewed certification: records the lifecycle transition via the EXISTING
 * recordStrategyLifecycleTransition() into learning_versions. This is the ONLY function
 * in this module that writes (a static test enforces exactly one call site).
 *
 * Refuses (fail-closed): unreviewed input, terminal current status (RETIRED/DEGRADED —
 * reversal requires the explicit reinstatement path), CHAMPION from anything but
 * VALIDATED, and any target outside the bridge's closed vocabulary.
 */
export async function executeCertificationTransition(
  reviewed: ReviewedCertification,
  now: Date = new Date(),
): Promise<ExecutedTransition> {
  validateReviewedCertification(reviewed);
  const { assessment, review } = reviewed;
  const strategyId = assessment.strategyId;

  if (findStrategy(strategyId) === undefined) {
    throw new Error(`CERTIFICATION_BRIDGE: UNKNOWN_STRATEGY — '${strategyId}' is not in the canonical registry`);
  }

  const oldStatus = await getStrategyLifecycleStatus(strategyId);
  if (oldStatus === 'RETIRED' || oldStatus === 'DEGRADED') {
    throw new Error(
      `CERTIFICATION_BRIDGE: TERMINAL_STATUS_REQUIRES_REINSTATEMENT — ${strategyId} is ${oldStatus}; ` +
        'a terminal exposure-removal decision can only be reversed via the explicit reinstatement path (reinstateStrategyForEmission -> ROLLED_BACK), never the certification bridge',
    );
  }

  const target = review.targetStatus;
  if (target === 'CHAMPION' && oldStatus !== 'VALIDATED') {
    throw new Error(
      `CERTIFICATION_BRIDGE: CHAMPION_REQUIRES_VALIDATED — CHAMPION promotes an already-validated strategy to ` +
        `"proven current best"; ${strategyId} is currently ${oldStatus}, not VALIDATED`,
    );
  }

  const decidedAt = new Date(review.decidedAt);
  const hypothesis =
    `Lifecycle certification bridge ${oldStatus} -> ${target}: ` +
    `reviewer '${review.reviewer}' at ${review.decidedAt}. ${review.statement} ` +
    `Assessment: ${assessment.reason}`;

  const evidencePayload: Record<string, unknown> = {
    bridge: CERTIFICATION_BRIDGE_VERSION,
    strategyId,
    oldStatus,
    newStatus: target,
    evidenceIds: assessment.provenance.evidenceIds,
    evidenceScope: assessment.provenance.evidenceScope,
    sampleSize: assessment.samples.backtestTrades,
    oosResult: { pass: assessment.gates.find((g) => g.gate === 'OOS_PASS_SUFFICIENT')?.pass ?? false, trades: assessment.samples.oosTrades },
    walkForwardResult: { pass: assessment.gates.find((g) => g.gate === 'WALK_FORWARD_SUFFICIENT')?.pass ?? false, windows: assessment.samples.walkForwardWindows },
    robustness: {
      monteCarlo: assessment.gates.find((g) => g.gate === 'ROBUSTNESS_MONTE_CARLO')?.pass ?? false,
      permutation: assessment.gates.find((g) => g.gate === 'ROBUSTNESS_PERMUTATION')?.pass ?? false,
      sensitivity: assessment.gates.find((g) => g.gate === 'ROBUSTNESS_SENSITIVITY')?.pass ?? false,
      costStress: assessment.gates.find((g) => g.gate === 'ROBUSTNESS_COST_STRESS')?.pass ?? false,
    },
    paper: {
      trades: assessment.gates.find((g) => g.gate === 'PAPER_TRADES')?.pass ?? false,
      sessions: assessment.gates.find((g) => g.gate === 'PAPER_SESSIONS')?.pass ?? false,
      calendarDays: assessment.gates.find((g) => g.gate === 'PAPER_CALENDAR_DAYS')?.pass ?? false,
      expectancyPositive: assessment.gates.find((g) => g.gate === 'PAPER_EXPECTANCY_POSITIVE')?.pass ?? false,
      drawdownWithinLimit: assessment.gates.find((g) => g.gate === 'PAPER_DRAWDOWN_WITHIN_LIMIT')?.pass ?? false,
      profitFactor: assessment.gates.find((g) => g.gate === 'PAPER_PROFIT_FACTOR')?.pass ?? false,
      organicOnly: assessment.gates.find((g) => g.gate === 'PAPER_ORGANIC_ONLY')?.pass ?? false,
    },
    gateFailures: assessment.gates.filter((g) => !g.pass).map((g) => g.gate),
    reason: assessment.reason,
    reviewer: review.reviewer,
    reviewedAt: review.decidedAt,
    assessedAt: assessment.assessedAt,
    executedAt: now.toISOString(),
    buildVersion: assessment.provenance.buildVersion,
  };

  const transitionId = await recordStrategyLifecycleTransition(
    strategyId,
    target,
    hypothesis,
    evidencePayload,
    assessment.samples.backtestTrades,
    decidedAt,
  );

  return { transitionId, strategyId, oldStatus, newStatus: target };
}
