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
 *   5. the strategy's DB-backed lifecycle (StrategyEmissionEligibility, learning_versions —
 *      the runtime-authoritative lifecycle; promotionEngine's ladder stays research-side)
 *      must be VALIDATED or CHAMPION. UNTESTED/SHADOW/CANDIDATE/ACTIVE_EXPLORATION/
 *      ROLLED_BACK keep today's consensus path (no behavior change); DEGRADED/RETIRED are
 *      terminally NOT_ELIGIBLE (their exposure was explicitly removed by evidence-backed
 *      operator decision).
 *
 * Only AUTHORIZED_QUANT_POLICY ideas may enter QuantExecutionPolicy. Everything else keeps
 * exactly the behavior it had before this change.
 *
 * Control-plane code: performs lookups and composes existing canonical sources. Contains no
 * quant/indicator/strategy calculations (Java 26 Engine Authority) and never imports
 * BrokerManager / OrderManagement / RiskEngine / ChiefTraderAgent / EventBus / AIRouter.
 */
import { findStrategy } from './strategies/StrategyEngine';
import { getStrategyLifecycleStatus } from './strategies/StrategyEmissionEligibility';
import { isPaperTradingOnlyEnforced } from '../core/tradingModeEnv';
import {
  normalizeTradeIdeaOrigin,
  isQuantClaimingOrigin,
  type TradeIdeaOrigin,
} from '../core/tradeIdeaProvenance';
import { isQuantPolicyEnabled, isQuantProducerAgent } from '../config/quantDecisionPolicy';

export type QuantAuthority = 'AUTHORIZED_QUANT_POLICY' | 'REQUIRES_CONSENSUS' | 'NOT_ELIGIBLE';

export type QuantAuthorizationReason =
  | 'POLICY_DISABLED'
  | 'ORIGIN_NOT_QUANT'
  | 'ENVIRONMENT_NOT_AUTHORIZED'
  | 'NO_STRATEGY_ID'
  | 'UNKNOWN_STRATEGY'
  | 'PRODUCER_NOT_QUANT'
  | 'STRATEGY_LIFECYCLE_LOOKUP_FAILED'
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
 * Resolve what decision policy an idea is authorized for. Never throws: on any internal
 * failure it fails closed to REQUIRES_CONSENSUS (never grants the new privilege) with an
 * explicit reason, so a broken lookup can never silently authorize the quant path.
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
  // Every other lifecycle (UNTESTED default, SHADOW, CANDIDATE, ACTIVE_EXPLORATION,
  // ROLLED_BACK): today's behavior, unchanged - the consensus path.
  const reason = CONSENSUS_LIFECYCLE_REASONS[lifecycleStatus] ?? 'STRATEGY_UNTESTED';
  return { ...withLifecycle, authority: 'REQUIRES_CONSENSUS', reason };
}
