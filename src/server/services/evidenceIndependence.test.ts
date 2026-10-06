import { describe, it, expect } from 'vitest';
import { resolveIndependentEvidenceGroup, CORE_QUANT_ENSEMBLE_EVIDENCE_GROUP } from './evidenceIndependence';

describe('resolveIndependentEvidenceGroup', () => {
  it('groups QuantEngine and JavaCoreEnsemble into the same CORE_QUANT_ENSEMBLE group', () => {
    expect(resolveIndependentEvidenceGroup('QuantEngine')).toBe(CORE_QUANT_ENSEMBLE_EVIDENCE_GROUP);
    expect(resolveIndependentEvidenceGroup('JavaCoreEnsemble')).toBe(CORE_QUANT_ENSEMBLE_EVIDENCE_GROUP);
  });

  // 2026-10-06 (Fast Lane Canonical Integration, Section 7 - "independence must not be inflated"):
  // FastOpportunityLane's evaluator calls the identical quantSignalAgent.evaluateSymbol()/
  // evaluateAll()/bestStrategyIdea() chain QuantEngine's own live cycle calls - structurally the
  // same underlying evidence, just a different arrival path. This is the exact mechanism that
  // prevents "arrived through two pipelines" from becoming "two independent votes."
  it('groups FastOpportunityLane with the SAME CORE_QUANT_ENSEMBLE group as QuantEngine/JavaCoreEnsemble - arrival path never manufactures independence', () => {
    expect(resolveIndependentEvidenceGroup('FastOpportunityLane')).toBe(CORE_QUANT_ENSEMBLE_EVIDENCE_GROUP);
    expect(resolveIndependentEvidenceGroup('FastOpportunityLane')).toBe(resolveIndependentEvidenceGroup('QuantEngine'));
  });

  it('does not group JavaFactorComposite with the CORE quant ensemble (distinct factor/GARCH/HMM model)', () => {
    expect(resolveIndependentEvidenceGroup('JavaFactorComposite')).toBe('JavaFactorComposite');
    expect(resolveIndependentEvidenceGroup('JavaFactorComposite')).not.toBe(CORE_QUANT_ENSEMBLE_EVIDENCE_GROUP);
  });

  it('leaves every other agent name as its own group (no assumed correlation without evidence)', () => {
    for (const agent of ['TechnicalAgent', 'FundamentalAgent', 'MacroAgent', 'NewsAgent', 'KronosForecastAgent', 'OpportunityScreener', 'TradePlanBuilder', 'ConsensusDebate']) {
      expect(resolveIndependentEvidenceGroup(agent)).toBe(agent);
    }
  });

  it('is a pure, deterministic function of its input', () => {
    expect(resolveIndependentEvidenceGroup('QuantEngine')).toBe(resolveIndependentEvidenceGroup('QuantEngine'));
  });
});
