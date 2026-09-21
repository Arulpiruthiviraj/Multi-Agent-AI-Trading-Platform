import { describe, it, expect } from 'vitest';
import { resolveIndependentEvidenceGroup, CORE_QUANT_ENSEMBLE_EVIDENCE_GROUP } from './evidenceIndependence';

describe('resolveIndependentEvidenceGroup', () => {
  it('groups QuantEngine and JavaCoreEnsemble into the same CORE_QUANT_ENSEMBLE group', () => {
    expect(resolveIndependentEvidenceGroup('QuantEngine')).toBe(CORE_QUANT_ENSEMBLE_EVIDENCE_GROUP);
    expect(resolveIndependentEvidenceGroup('JavaCoreEnsemble')).toBe(CORE_QUANT_ENSEMBLE_EVIDENCE_GROUP);
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
