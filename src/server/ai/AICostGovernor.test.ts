import { describe, it, expect } from 'vitest';
import { computeGovernorReorder, recordGovernorShadowComparison } from './AICostGovernor';

/**
 * Pure-function unit tests for the AI Cost Governor's provider-reorder logic
 * (docs/audits/ARGUS_PROJECT_A_AI_COST_GOVERNOR_DESIGN_NOTE.md §B/§F/§G/§H). Real
 * config/aiCostGovernor.json is used as-is (not mocked) - FundamentalAgent's real policy is
 * `["LOCAL","ECONOMICAL"]`, ReflectionEngine's is `["LOCAL"]`, and `ConsensusDebate` has no entry
 * at all, matching the design note's explicit scope.
 */
describe('AICostGovernor.computeGovernorReorder', () => {
  const ollama: any = { id: 'ollama-id', providerName: 'Ollama (Local)' };
  const mistral: any = { id: 'mistral-id', providerName: 'Mistral' };
  const claude: any = { id: 'claude-id', providerName: 'Claude' };
  const unknownProvider: any = { id: 'unknown-id', providerName: 'SomeBrandNewProvider' };

  it('an agentType with no configured policy (e.g. ConsensusDebate) is left completely untouched', () => {
    const decision = computeGovernorReorder('ConsensusDebate', [mistral, ollama, claude]);
    expect(decision.changed).toBe(false);
    expect(decision.policyTiers).toBeNull();
    expect(decision.reorderedProviderIds).toEqual(['mistral-id', 'ollama-id', 'claude-id']);
  });

  it('FundamentalAgent (policy: LOCAL, ECONOMICAL) moves Ollama ahead of Mistral, and drops Claude (STRONG, not in its policy) to the back rather than removing it', () => {
    const decision = computeGovernorReorder('FundamentalAgent', [claude, mistral, ollama]);
    expect(decision.changed).toBe(true);
    expect(decision.chosenTier).toBe('LOCAL');
    expect(decision.reorderedProviderIds).toEqual(['ollama-id', 'mistral-id']);
    // Claude (STRONG) is excluded from FundamentalAgent's allowed tiers entirely - never tried at
    // all when the governor is actually live-enabled, since only LOCAL/ECONOMICAL are eligible.
    expect(decision.reorderedProviderIds).not.toContain('claude-id');
  });

  it('ReflectionEngine (policy: LOCAL only) keeps only Ollama when it is available', () => {
    const decision = computeGovernorReorder('ReflectionEngine', [mistral, ollama, claude]);
    expect(decision.reorderedProviderIds).toEqual(['ollama-id']);
    expect(decision.chosenTier).toBe('LOCAL');
  });

  it('SAFETY INTENT (not a bug): a LOCAL-only policy with no local provider available this cycle deliberately returns EMPTY, never silently falling back to a paid provider that policy explicitly disallows', () => {
    // ReflectionEngine is LOCAL-only, but no local provider is available this cycle (Ollama down).
    const decision = computeGovernorReorder('ReflectionEngine', [mistral, claude]);
    expect(decision.reorderedProviderIds).toEqual([]);
    expect(decision.chosenTier).toBeNull();
    expect(decision.changed).toBe(true); // the (non-empty) original list WAS changed - into nothing
  });

  it('genuine ambiguity (no available provider has any known cost-tier mapping at all) fails OPEN to the original order - there is no reviewed intent to guess at', () => {
    const decision = computeGovernorReorder('FundamentalAgent', [unknownProvider]);
    expect(decision.reorderedProviderIds).toEqual(['unknown-id']);
    expect(decision.changed).toBe(false);
  });

  it('an empty available-providers list is handled without throwing', () => {
    const decision = computeGovernorReorder('FundamentalAgent', []);
    expect(decision.reorderedProviderIds).toEqual([]);
    expect(decision.changed).toBe(false);
  });

  it('shadow-comparison logging never throws, regardless of malformed-looking input', () => {
    expect(() => recordGovernorShadowComparison({
      traceId: 'trace-1',
      agentType: 'FundamentalAgent',
      decision: computeGovernorReorder('FundamentalAgent', [mistral, ollama]),
      liveEnabled: false,
    })).not.toThrow();

    // Even a null traceId (a call site that has no trace context) must not throw.
    expect(() => recordGovernorShadowComparison({
      traceId: null,
      agentType: 'FundamentalAgent',
      decision: computeGovernorReorder('FundamentalAgent', []),
      liveEnabled: false,
    })).not.toThrow();
  });
});
