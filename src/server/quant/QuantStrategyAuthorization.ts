/**
 * QuantStrategyAuthorization — the SINGLE central resolver for AI-independent quant
 * execution authority (Quant-First Decision Architecture, 2026-10-07).
 *
 * PROVENANCE IS NOT AUTHORIZATION. An idea may declare `origin: 'QUANT_STRATEGY'` and name
 * any strategyId it likes; this resolver independently verifies, from canonical sources,
 * before ChiefTrader will ever route the idea to QuantExecutionPolicy:
 *
 *   1. origin must be QUANT_STRATEGY (anything else -> REQUIRES_CONSENSUS, unchanged path)
 *   2. the paper-only environment lock must be engaged (LIVE -> NOT_ELIGIBLE, fail-closed)
 *   3. strategyId must name a real strategy in the canonical registry
 *      (StrategyEngine.findStrategy — no TS literals, no invented ids)
 *   4. the emitting agent must be a registered quant producer
 *      (config/quantDecisionPolicy.json — a News/Technical/AI agent can never self-promote
 *      by setting origin/strategyId metadata)
 *   5. a lifecycle record for the strategy must genuinely exist in learning_versions
 *      (hasStrategyLifecycleRecord — a missing record is NOT_AUTHORIZED/NO_LIFECYCLE_RECORD,
 *      terminal; it must never silently inherit the UNTESTED default's semantics), and the
 *      most recent decision (StrategyEmissionEligibility, learning_versions — the
 *      runtime-authoritative lifecycle; promotionEngine's ladder stays research-side)
 *      must be VALIDATED or CHAMPION. UNTESTED/SHADOW/CANDIDATE/ACTIVE_EXPLORATION/
 *      ROLLED_BACK keep today's consensus path (no behavior change); DEGRADED/RETIRED are
 *      terminally NOT_ELIGIBLE (their exposure was explicitly removed by evidence-backed
 *      operator decision).
 *
 * EMISSION ELIGIBILITY ≠ EXECUTION AUTHORITY (2026-10-08, defect #1). Two named concepts,
 * two distinct predicates — a future reader must never confuse "may emit an idea" with
 * "may execute via the quant policy":
 *
 *   1. EMISSION ELIGIBILITY — "may emit an idea". Predicate: mayEmitStrategyIdea() (this
 *      module), which delegates to StrategyEmissionEligibility.isStrategyQuarantinedForEmission.
 *      Decides the real-selection pool bestStrategyIdea() picks from. Only RETIRED and
 *      DEGRADED remove a strategy from that pool.
 *   2. EXECUTION AUTHORITY — "may execute via QuantExecutionPolicy without consensus".
 *      Predicate: resolveQuantStrategyAuthorization() (this module). Conjunctive,
 *      fail-closed; the narrow new privilege this whole change exists for.
 *
 * ACTIVE_EXPLORATION evidence conclusion (2026-10-08): the code proves ACTIVE_EXPLORATION
 * was designed as emission eligibility, NOT execution authority. StrategyEmissionEligibility
 * documents it as "bounded, monitored real exposure while evidence accumulates. Eligible."
 * — eligibility for the real-selection pool, whose ideas then take the unchanged consensus
 * intake ("real exposure" via the normal spine, never via the AI-independent path). The
 * quant-first design (docs/architecture/ARGUS_QUANT_FIRST_DECISION_ARCHITECTURE.md §4 and
 * docs/architecture/ARGUS_ARCHITECTURE.md's 2026-10-07 entry) explicitly requires DB
 * lifecycle VALIDATED/CHAMPION for AUTHORIZED_QUANT_POLICY and routes ACTIVE_EXPLORATION
 * to REQUIRES_CONSENSUS. Therefore: ACTIVE_EXPLORATION + PAPER ⇒ REQUIRES_CONSENSUS
 * (never QuantExecutionPolicy); ACTIVE_EXPLORATION + LIVE ⇒ NOT_ELIGIBLE, because the
 * paper-only environment lock fails first — no LIVE authority exists anywhere in this
 * module, under any lifecycle status.
 *
 * NOT_AUTHORIZED ROUTING CONTRACT (honored by ChiefTraderAgent.reviewIdea): NOT_AUTHORIZED
 * is terminal — the idea is dropped with a DESK_NO_TRADE event (terminalReasonCode
 * 'QUANT_NOT_AUTHORIZED', quantReasonCode 'NO_LIFECYCLE_RECORD'), never re-routed to
 * consensus. Rationale: a missing lifecycle record means no eligibility decision was ever
 * recorded for this strategy. Routing it to consensus would let missing state silently
 * inherit today's consensus behavior, hiding the operational gap defect #1 exposed (CORE
 * strategies trading with no lifecycle record at all). Safety wins over preserving that
 * behavior: the operator records an explicit decision (an UNTESTED baseline row at
 * minimum) via recordStrategyLifecycleTransition and routing resumes. A transient lookup
 * failure is different and stays REQUIRES_CONSENSUS + STRATEGY_LIFECYCLE_LOOKUP_FAILED —
 * an outage must not wedge the desk, and the consensus path is the safe default there.
 *
 * Only AUTHORIZED_QUANT_POLICY ideas may enter QuantExecutionPolicy. Everything else keeps
 * exactly the behavior it had before this change, except the genuinely-missing-record
 * case above, which is now explicit and terminal instead of silently defaulting.
 *
 * Control-plane code: performs lookups and composes existing canonical sources. Contains no
 * quant/indicator/strategy calculations (Java 26 Engine Authority) and never imports
 * BrokerManager / OrderManagement / RiskEngine / ChiefTraderAgent / EventBus / AIRouter.
 */
import { findStrategy } from './strategies/StrategyEngine';
import { getStrategyLifecycleStatus, hasStrategyLifecycleRecord, isStrategyQuarantinedForEmission } from './strategies/StrategyEmissionEligibility';
import { isPaperTradingOnlyEnforced } from '../core/tradingModeEnv';
import {
  normalizeTradeIdeaOrigin,
  isQuantClaimingOrigin,
  type TradeIdeaOrigin,
} from '../core/tradeIdeaProvenance';
import { isQuantPolicyEnabled, isQuantProducerAgent } from '../config/quantDecisionPolicy';

/**
 * AUTHORIZED_QUANT_POLICY: the idea may enter QuantExecutionPolicy (AI-independent execution).
 * REQUIRES_CONSENSUS:     the idea keeps the unchanged consensus path (no new privilege).
 * NOT_ELIGIBLE:           an explicit, evidence-backed operator decision removed this strategy
 *                         from selection (DEGRADED/RETIRED), or the environment lock failed
 *                         (LIVE) — terminal, never re-routed.
 * NOT_AUTHORIZED:         no lifecycle record exists for the strategy — missing state, not an
 *                         explicit decision. Terminal: ChiefTrader drops the idea (DESK_NO_TRADE,
 *                         'QUANT_NOT_AUTHORIZED'), never re-routed to consensus. Distinct from
 *                         NOT_ELIGIBLE: NOT_ELIGIBLE is "we decided no"; NOT_AUTHORIZED is "nobody
 *                         ever decided". See the module header's routing contract.
 */
export type QuantAuthority = 'AUTHORIZED_QUANT_POLICY' | 'REQUIRES_CONSENSUS' | 'NOT_ELIGIBLE' | 'NOT_AUTHORIZED';

export type QuantAuthorizationReason =
  | 'POLICY_DISABLED'
  | 'ORIGIN_NOT_QUANT'
  | 'ENVIRONMENT_NOT_AUTHORIZED'
  | 'NO_STRATEGY_ID'
  | 'UNKNOWN_STRATEGY'
  | 'PRODUCER_NOT_QUANT'
  | 'STRATEGY_LIFECYCLE_LOOKUP_FAILED'
  | 'NO_LIFECYCLE_RECORD'
  | 'STRATEGY_UNTESTED'
  | 'STRATEGY_SHADOW'
  | 'STRATEGY_CANDIDATE'
  | 'STRATEGY_ACTIVE_EXPLORATION'
  | 'STRATEGY_ROLLED_BACK'
  | 'STRATEGY_DEGRADED'
  | 'STRATEGY_RETIRED'
  | 'STRATEGY_VALIDATED'
  | 'STRATEGY_CHAMPION';

export interface QuantStrategyAuthorization {
  authority: QuantAuthority;
  reason: QuantAuthorizationReason;
  origin: TradeIdeaOrigin;
  strategyId: string | null;
  /**
   * The strategy's most recent lifecycle decision, or null when the resolver never reached a
   * lifecycle lookup (early return) or when no lifecycle record exists at all
   * (NOT_AUTHORIZED/NO_LIFECYCLE_RECORD). Null here for NO_LIFECYCLE_RECORD is deliberate:
   * reporting 'UNTESTED' would falsely imply a recorded decision.
   */
  lifecycleStatus: string | null;
  producerAgent: string | null;
  paperOnlyEnforced: boolean;
  checkedAt: string;
}

export interface AuthorizationIdeaInput {
  origin?: unknown;
  strategyId?: unknown;
  agent?: unknown;
}

const CONSENSUS_LIFECYCLE_REASONS: Record<string, QuantAuthorizationReason> = {
  UNTESTED: 'STRATEGY_UNTESTED',
  SHADOW: 'STRATEGY_SHADOW',
  CANDIDATE: 'STRATEGY_CANDIDATE',
  ACTIVE_EXPLORATION: 'STRATEGY_ACTIVE_EXPLORATION',
  ROLLED_BACK: 'STRATEGY_ROLLED_BACK',
};

function base(input: AuthorizationIdeaInput, origin: TradeIdeaOrigin): Omit<QuantStrategyAuthorization, 'authority' | 'reason'> {
  const strategyId = typeof input.strategyId === 'string' && input.strategyId.trim() !== ''
    ? input.strategyId.trim()
    : null;
  return {
    origin,
    strategyId,
    lifecycleStatus: null,
    producerAgent: typeof input.agent === 'string' ? input.agent : null,
    paperOnlyEnforced: isPaperTradingOnlyEnforced(),
    checkedAt: new Date().toISOString(),
  };
}

/**
 * NAMED CONCEPT 1 — EMISSION ELIGIBILITY: "may emit an idea".
 *
 * True when the strategy is not quarantined from the real-selection pool: only an explicit,
 * evidence-backed RETIRED or DEGRADED decision removes a strategy here; every other status —
 * including UNTESTED, SHADOW, CANDIDATE, ACTIVE_EXPLORATION, and a strategy with no lifecycle
 * record at all — remains eligible to have its evaluated ideas emitted into ChiefTrader
 * intake (where they then face the unchanged consensus path). This is deliberately a
 * SEPARATE predicate from resolveQuantStrategyAuthorization (execution authority): emission
 * eligibility answers "may this strategy's ideas be considered"; it never answers "may this
 * idea skip consensus".
 */
export async function mayEmitStrategyIdea(strategyId: string): Promise<boolean> {
  if (typeof strategyId !== 'string' || strategyId.trim() === '') return false;
  return !(await isStrategyQuarantinedForEmission(strategyId.trim()));
}

/**
 * NAMED CONCEPT 2 — EXECUTION AUTHORITY: "may execute via QuantExecutionPolicy".
 * resolveQuantStrategyAuthorization() below is the single resolver for this concept.
 * Never throws: on any internal failure it fails closed to REQUIRES_CONSENSUS (never
 * grants the new privilege) with an explicit reason, so a broken lookup can never
 * silently authorize the quant path. A genuinely absent lifecycle record is NOT a lookup
 * failure: it resolves to NOT_AUTHORIZED/NO_LIFECYCLE_RECORD (terminal), so missing
 * state is visible and privileged-by-default is impossible.
 */
export async function resolveQuantStrategyAuthorization(
  idea: AuthorizationIdeaInput,
): Promise<QuantStrategyAuthorization> {
  const origin = normalizeTradeIdeaOrigin(idea?.origin);
  const common = base(idea ?? {}, origin);

  if (!isQuantPolicyEnabled()) {
    return { ...common, authority: 'REQUIRES_CONSENSUS', reason: 'POLICY_DISABLED' };
  }
  if (!isQuantClaimingOrigin(origin)) {
    return { ...common, authority: 'REQUIRES_CONSENSUS', reason: 'ORIGIN_NOT_QUANT' };
  }
  // LIVE fail-closed: AI-independent quant authority exists only under the paper-only env
  // lock. Without it the environment could be live; no new privilege is granted there.
  if (!common.paperOnlyEnforced) {
    return { ...common, authority: 'NOT_ELIGIBLE', reason: 'ENVIRONMENT_NOT_AUTHORIZED' };
  }
  if (!common.strategyId) {
    return { ...common, authority: 'REQUIRES_CONSENSUS', reason: 'NO_STRATEGY_ID' };
  }
  // Canonical registry check — a strategyId no strategy defines can never be authorized.
  if (!findStrategy(common.strategyId)) {
    return { ...common, authority: 'REQUIRES_CONSENSUS', reason: 'UNKNOWN_STRATEGY' };
  }
  // Producer check — the anti-self-promotion rule: only registered quant producers may carry
  // quant provenance into the authorization check. Anyone else falls back to consensus.
  if (!isQuantProducerAgent(common.producerAgent ?? '')) {
    return { ...common, authority: 'REQUIRES_CONSENSUS', reason: 'PRODUCER_NOT_QUANT' };
  }

  let lifecycleStatus: string;
  try {
    // Missing-state check FIRST, inside the same fail-closed try: a genuinely absent
    // lifecycle record is NOT the same as a recorded UNTESTED status. getStrategyLifecycleStatus
    // defaults to 'UNTESTED' when no row exists, which would let missing state silently inherit
    // the UNTESTED default's consensus-path semantics and hide the operational gap. Absence of
    // a decision is itself a finding: NOT_AUTHORIZED/NO_LIFECYCLE_RECORD, terminal.
    const recordExists = await hasStrategyLifecycleRecord(common.strategyId);
    if (!recordExists) {
      console.warn(
        `[QuantStrategyAuthorization] no lifecycle record for ${common.strategyId} - failing closed ` +
          `(NOT_AUTHORIZED/NO_LIFECYCLE_RECORD). Record an explicit lifecycle decision (e.g. UNTESTED baseline) ` +
          'via recordStrategyLifecycleTransition to restore routing.',
      );
      return { ...common, lifecycleStatus: null, authority: 'NOT_AUTHORIZED', reason: 'NO_LIFECYCLE_RECORD' };
    }
    lifecycleStatus = await getStrategyLifecycleStatus(common.strategyId);
  } catch (e) {
    // Cannot verify authorization -> no new privilege. The idea keeps today's consensus path.
    console.warn(
      `[QuantStrategyAuthorization] lifecycle lookup failed for ${common.strategyId} - failing closed to consensus`,
      e,
    );
    return { ...common, authority: 'REQUIRES_CONSENSUS', reason: 'STRATEGY_LIFECYCLE_LOOKUP_FAILED' };
  }
  const withLifecycle = { ...common, lifecycleStatus };

  // Exposure-removing statuses: an explicit, evidence-backed operator decision removed this
  // strategy from real selection. It is terminally ineligible - not re-routed to consensus.
  if (lifecycleStatus === 'DEGRADED') {
    return { ...withLifecycle, authority: 'NOT_ELIGIBLE', reason: 'STRATEGY_DEGRADED' };
  }
  if (lifecycleStatus === 'RETIRED') {
    return { ...withLifecycle, authority: 'NOT_ELIGIBLE', reason: 'STRATEGY_RETIRED' };
  }
  // Positive authorization: only an explicit VALIDATED/CHAMPION lifecycle decision grants
  // AI-independent execution. This is the narrow new privilege this whole change exists for.
  if (lifecycleStatus === 'VALIDATED') {
    return { ...withLifecycle, authority: 'AUTHORIZED_QUANT_POLICY', reason: 'STRATEGY_VALIDATED' };
  }
  if (lifecycleStatus === 'CHAMPION') {
    return { ...withLifecycle, authority: 'AUTHORIZED_QUANT_POLICY', reason: 'STRATEGY_CHAMPION' };
  }
  // Every other lifecycle (recorded UNTESTED — a row genuinely exists — SHADOW, CANDIDATE,
  // ACTIVE_EXPLORATION, ROLLED_BACK): today's behavior, unchanged - the consensus path.
  // Note: a strategy with NO lifecycle record never reaches this point; it is
  // NOT_AUTHORIZED/NO_LIFECYCLE_RECORD above, never silently treated as UNTESTED.
  const reason = CONSENSUS_LIFECYCLE_REASONS[lifecycleStatus] ?? 'STRATEGY_UNTESTED';
  return { ...withLifecycle, authority: 'REQUIRES_CONSENSUS', reason };
}
