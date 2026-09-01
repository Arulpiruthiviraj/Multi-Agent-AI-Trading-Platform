/**
 * AICostGovernor - Phase A4/A5 of the AI Cost Governor design note
 * (docs/audits/ARGUS_PROJECT_A_AI_COST_GOVERNOR_DESIGN_NOTE.md). Reorders (never removes-to-empty)
 * the already-routable provider list AIRouter.routeTask() was about to try, preferring cheaper
 * cost tiers first for agent types whose reviewed policy allows it. Composes with, never replaces,
 * AIRouter's own provider-health/cooldown filtering - it only reorders providers that already
 * survived filterRoutableProviders().
 *
 * SCOPE, stated honestly: this pass implements policy-driven provider ORDERING/eligibility
 * filtering (a real, safe, immediately cost-relevant mechanism - e.g. an agent whose policy is
 * `["LOCAL"]` never has a remote/paid provider tried ahead of an available local one). It does NOT
 * yet inspect a completed response's quality mid-call to decide whether to escalate further within
 * one request (that deeper mechanism is Phase A7 "adaptive routing" territory and is explicitly not
 * built here) - AIRouter's existing sequential per-provider loop and its own success/failure
 * semantics are completely unchanged; this module only decides the ORDER providers within that loop
 * are tried in.
 *
 * SAFETY INVARIANTS (do not weaken):
 * - An explicit, reviewed policy that excludes every currently-available provider is an
 *   INTENTIONAL fail-closed outcome, not a bug worked around here: an agent configured `["LOCAL"]`
 *   must never silently fall back to paying for a remote/paid provider just because Ollama happened
 *   to be unavailable this cycle - that would defeat the entire point of the policy. AIRouter's
 *   existing `availableProviders.length === 0` branch (NO_ROUTABLE_AI_PROVIDERS -> fail-closed HOLD)
 *   already handles an empty list correctly - this is not a new failure mode, and every agent this
 *   governor's policies cover today is advisory-only (never gates a trade directly).
 * - The ONLY case this module falls back to the ORIGINAL, untouched order is genuine ambiguity: no
 *   currently-available provider has any known cost-tier mapping at all (a data/config quality
 *   issue, not an intentional exclusion) - there, failing open is correct because there's no
 *   reviewed intent to honor.
 * - Never touches ChiefTraderAgent, RiskEngine, OrderManagementService, BrokerManager, consensus
 *   thresholds, or routeConsensus's parallel ensemble fan-out (ConsensusDebate has no policy entry
 *   in config/aiCostGovernor.json - out of scope entirely, not merely unconfigured).
 * - Fails open: any internal error here must be caught by the caller and treated as "no reorder" -
 *   see AIRouter.ts's call site.
 */
import { policyForAgentType, costTierForProviderName, type CostTier } from '../config/aiCostGovernor';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';

export interface GovernorProviderRow {
  id: string;
  providerName: string;
}

export interface GovernorDecision {
  agentType: string;
  policyTiers: CostTier[] | null;
  chosenTier: CostTier | null;
  reorderedProviderIds: string[];
  originalProviderIds: string[];
  changed: boolean;
}

/**
 * Pure function - no I/O, no DB, no side effects. Given the provider list AIRouter already
 * determined is routable (health/cooldown-filtered), returns the order (or, deliberately, the
 * empty set) the governor's reviewed policy would prefer.
 */
export function computeGovernorReorder(agentType: string, availableProviders: GovernorProviderRow[]): GovernorDecision {
  const originalProviderIds = availableProviders.map((p) => p.id);
  const policy = policyForAgentType(agentType);
  if (!policy || availableProviders.length === 0) {
    return { agentType, policyTiers: policy?.tiers ?? null, chosenTier: null, reorderedProviderIds: originalProviderIds, originalProviderIds, changed: false };
  }

  const withKnownTier = availableProviders.filter((p) => costTierForProviderName(p.providerName) !== undefined);
  if (withKnownTier.length === 0) {
    // Genuine ambiguity, not an intentional exclusion: not one currently-available provider has any
    // cost-tier mapping at all. Fail OPEN to the original order - there is no reviewed intent here
    // to honor, so guessing which one to prefer would be inventing a preference, not applying one.
    return { agentType, policyTiers: policy.tiers, chosenTier: null, reorderedProviderIds: originalProviderIds, originalProviderIds, changed: false };
  }

  const tierRank = (p: GovernorProviderRow): number => policy.tiers.indexOf(costTierForProviderName(p.providerName)!);
  const eligible = withKnownTier.filter((p) => tierRank(p) !== -1);
  // `eligible` may legitimately be EMPTY here: every currently-available, known-tier provider sits
  // outside this agent's allowed tiers (e.g. a LOCAL-only agent with no local provider routable this
  // cycle). That is the intentional fail-closed outcome described above, not a fallback case.
  const ranked = [...eligible].sort((a, b) => tierRank(a) - tierRank(b));
  const reorderedProviderIds = ranked.map((p) => p.id);
  const changed = JSON.stringify(reorderedProviderIds) !== JSON.stringify(originalProviderIds);
  const chosenTier = ranked[0] ? costTierForProviderName(ranked[0].providerName) ?? null : null;

  return { agentType, policyTiers: policy.tiers, chosenTier, reorderedProviderIds, originalProviderIds, changed };
}

/**
 * Shadow-mode logging - mirrors ConsensusModelComparison.ts's recordConsensusModelComparison()
 * byte-for-byte in shape: reuses observability_events (no new table), wrapped in observeSafe() so a
 * logging bug can never affect the real call. Logs what the governor WOULD have chosen, regardless
 * of whether it's actually live-enabled to act on it.
 */
export function recordGovernorShadowComparison(input: {
  traceId: string | null;
  agentType: string;
  decision: GovernorDecision;
  liveEnabled: boolean;
}): void {
  observeSafe(() => {
    structuredLogger.info('ai_cost_governor_shadow_comparison', {
      category: 'AI',
      eventType: 'AI_COST_GOVERNOR_SHADOW_COMPARISON',
      traceId: input.traceId ?? undefined,
      decisionId: input.traceId ?? undefined,
      agentType: input.agentType,
      policyTiers: input.decision.policyTiers,
      chosenTier: input.decision.chosenTier,
      originalProviderIds: input.decision.originalProviderIds,
      reorderedProviderIds: input.decision.reorderedProviderIds,
      changed: input.decision.changed,
      liveEnabled: input.liveEnabled,
    });
  });
}
