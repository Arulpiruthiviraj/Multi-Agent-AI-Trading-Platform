import { describe, it, expect } from 'vitest';
import { classifyEvidenceFamily } from './evidenceFamilyTaxonomy';
import { resolveIndependentEvidenceGroup } from './evidenceIndependence';

describe('classifyEvidenceFamily', () => {
  it('classifies every currently-live agent with currentlyLive=true and a real family/dependency', () => {
    const liveAgents = [
      'TechnicalAgent', 'NewsAgent', 'FundamentalAgent', 'MacroAgent', 'KronosEngine',
      'QuantEngine', 'JavaCoreEnsemble', 'JavaFactorComposite', 'OpportunityScreener',
      'TradePlanBuilder', 'PortfolioManager', 'ConsensusDebate',
    ];
    for (const agent of liveAgents) {
      const result = classifyEvidenceFamily(agent);
      expect(result.currentlyLive).toBe(true);
      expect(result.methodologyFamily).not.toBe('UNCLASSIFIED');
      expect(result.dataDependency).not.toBe('UNKNOWN');
      expect(result.agent).toBe(agent);
    }
  });

  it('never changes the independent-evidence-group value the live consensus approval math already uses', () => {
    // This is the load-bearing safety property: classifyEvidenceFamily must be purely additive on
    // top of resolveIndependentEvidenceGroup, never a second, divergent grouping computation.
    const agents = ['TechnicalAgent', 'QuantEngine', 'JavaCoreEnsemble', 'JavaFactorComposite', 'NewsAgent'];
    for (const agent of agents) {
      expect(classifyEvidenceFamily(agent).independentEvidenceGroup).toBe(resolveIndependentEvidenceGroup(agent));
    }
  });

  it('groups QuantEngine and JavaCoreEnsemble into the same independent evidence group but keeps them as distinct methodology-family entries with the same family value', () => {
    const quant = classifyEvidenceFamily('QuantEngine');
    const javaCore = classifyEvidenceFamily('JavaCoreEnsemble');
    expect(quant.independentEvidenceGroup).toBe(javaCore.independentEvidenceGroup);
    expect(quant.methodologyFamily).toBe('CORE_STRATEGY_ENSEMBLE');
    expect(javaCore.methodologyFamily).toBe('CORE_STRATEGY_ENSEMBLE');
  });

  it('returns UNCLASSIFIED/UNKNOWN/currentlyLive=false for an unrecognized agent name rather than guessing', () => {
    const result = classifyEvidenceFamily('SomeFutureAgentNobodyDefinedYet');
    expect(result.methodologyFamily).toBe('UNCLASSIFIED');
    expect(result.dataDependency).toBe('UNKNOWN');
    expect(result.currentlyLive).toBe(false);
  });

  it('classifies the ta4j/ojAlgo placeholder families as defined but explicitly not live', () => {
    const ta4j = classifyEvidenceFamily('Ta4jTechnicalParity');
    expect(ta4j.methodologyFamily).toBe('TA_LIBRARY_PARITY_CHECK');
    expect(ta4j.currentlyLive).toBe(false);

    const ojAlgo = classifyEvidenceFamily('OjAlgoPortfolioRisk');
    expect(ojAlgo.methodologyFamily).toBe('PORTFOLIO_OPTIMIZATION');
    expect(ojAlgo.currentlyLive).toBe(false);
  });
});
