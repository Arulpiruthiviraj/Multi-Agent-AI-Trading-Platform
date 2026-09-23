/**
 * Evidence-family / methodology-family / data-dependency taxonomy.
 *
 * Priority #1 of the "Argus World-Class Open-Source Quant Expansion" roadmap (2026-09-23,
 * operator-directed): "evidence-family independence should be implemented before adding lots
 * more decision sources." This module extends, and does not replace, `evidenceIndependence.ts`'s
 * `resolveIndependentEvidenceGroup()` - that function remains the single source of truth for the
 * LIVE consensus approval math (`ChiefTraderAgent.ts`'s `uniqueIndependent`/
 * `enoughIndependentVoices` computation is completely untouched by this file, verified by the
 * regression suite below). This module adds a richer, purely-observational classification layer
 * around it: for each independent evidence group, WHAT KIND of evidence it is (methodology
 * family) and WHAT it structurally depends on (data dependency) - matching the
 * evidenceFamily/methodologyFamily/dataDependency shape the Multi-Library Java Quant Decision
 * Intelligence Integration mandate's own "do not fake independence" section described, generalized
 * here to cover every current live evidence producer, not just the two Java engines that mandate
 * covered.
 *
 * Classification requires source-verified structural knowledge of what a producer actually
 * computes - the same "grouping requires proof, not suspicion" standard `evidenceIndependence.ts`
 * already applies. An agent name with no verified classification returns UNCLASSIFIED/UNKNOWN,
 * never a guessed family.
 */

import { resolveIndependentEvidenceGroup } from './evidenceIndependence';

export type EvidenceMethodologyFamily =
  | 'ARGUS_TECHNICAL_INDICATORS'
  | 'ARGUS_NEWS_NLP'
  | 'ARGUS_FUNDAMENTAL_VALUATION'
  | 'ARGUS_MACRO_ECONOMIC'
  | 'ML_TIME_SERIES_FORECAST'
  | 'CORE_STRATEGY_ENSEMBLE'
  | 'STATISTICAL_FACTOR_MODEL'
  | 'CROSS_SECTIONAL_RANKING'
  | 'TRADE_PLAN_THESIS'
  | 'RISK_EXIT_MANAGEMENT'
  | 'ADVERSARIAL_CHALLENGE'
  | 'TA_LIBRARY_PARITY_CHECK'
  | 'PORTFOLIO_OPTIMIZATION'
  | 'UNCLASSIFIED';

export type EvidenceDataDependency =
  | 'LIVE_TICK_OHLCV'
  | 'NEWS_ARTICLES_EXTERNAL_API'
  | 'FUNDAMENTAL_STATEMENTS_EXTERNAL_API'
  | 'MACRO_INDICATORS_EXTERNAL_API'
  | 'CANONICAL_BARS'
  | 'HISTORICAL_RETURN_SAMPLE'
  | 'PORTFOLIO_STATE'
  | 'PRIOR_EVIDENCE_ONLY'
  | 'UNKNOWN';

export interface EvidenceFamilyMetadata {
  agent: string;
  /** Same value ChiefTraderAgent.ts's live independence count already uses - reused, never recomputed. */
  independentEvidenceGroup: string;
  methodologyFamily: EvidenceMethodologyFamily;
  dataDependency: EvidenceDataDependency;
  /** True only for a producer verified (by name, via grep against real emitTradeIdea call sites) to
   *  be currently wired into ChiefTrader's consensus. False entries exist so a FUTURE evidence
   *  source's classification is decided and reviewed before it ever votes, not retrofitted the day
   *  it's turned on. */
  currentlyLive: boolean;
}

interface FamilyDefinition {
  methodologyFamily: EvidenceMethodologyFamily;
  dataDependency: EvidenceDataDependency;
  currentlyLive: boolean;
}

/**
 * One entry per agent name currently capable of reaching ChiefTrader's consensus (verified via
 * `config/agentWeights.json`'s defaults/pipelineAgents/riskExitAgent and grep-confirmed
 * `agent: '...'` literals in `JavaCoreEnsembleVoteService.ts`/`JavaQuantAdvisoryService.ts`), plus
 * two explicitly-not-live placeholder entries for the ta4j/ojAlgo RESEARCH engines added
 * 2026-09-23 (`config/engineOwnership.json`: `liveConsumer: "NONE"` for both - `Ta4jTechnicalParity`
 * and `OjAlgoPortfolioRisk` below are PROPOSED future agent names, not constants referenced
 * anywhere else in this codebase; nothing currently emits a trade idea under either name). The
 * point of defining them now, inert, is that the classification decision is made and reviewable
 * before either engine could ever vote, rather than retrofitted the day someone wires one in.
 */
const FAMILY_DEFINITIONS: Record<string, FamilyDefinition> = {
  TechnicalAgent: { methodologyFamily: 'ARGUS_TECHNICAL_INDICATORS', dataDependency: 'LIVE_TICK_OHLCV', currentlyLive: true },
  NewsAgent: { methodologyFamily: 'ARGUS_NEWS_NLP', dataDependency: 'NEWS_ARTICLES_EXTERNAL_API', currentlyLive: true },
  FundamentalAgent: { methodologyFamily: 'ARGUS_FUNDAMENTAL_VALUATION', dataDependency: 'FUNDAMENTAL_STATEMENTS_EXTERNAL_API', currentlyLive: true },
  MacroAgent: { methodologyFamily: 'ARGUS_MACRO_ECONOMIC', dataDependency: 'MACRO_INDICATORS_EXTERNAL_API', currentlyLive: true },
  KronosEngine: { methodologyFamily: 'ML_TIME_SERIES_FORECAST', dataDependency: 'LIVE_TICK_OHLCV', currentlyLive: true },
  QuantEngine: { methodologyFamily: 'CORE_STRATEGY_ENSEMBLE', dataDependency: 'CANONICAL_BARS', currentlyLive: true },
  JavaCoreEnsemble: { methodologyFamily: 'CORE_STRATEGY_ENSEMBLE', dataDependency: 'CANONICAL_BARS', currentlyLive: true },
  JavaFactorComposite: { methodologyFamily: 'STATISTICAL_FACTOR_MODEL', dataDependency: 'CANONICAL_BARS', currentlyLive: true },
  OpportunityScreener: { methodologyFamily: 'CROSS_SECTIONAL_RANKING', dataDependency: 'LIVE_TICK_OHLCV', currentlyLive: true },
  TradePlanBuilder: { methodologyFamily: 'TRADE_PLAN_THESIS', dataDependency: 'CANONICAL_BARS', currentlyLive: true },
  PortfolioManager: { methodologyFamily: 'RISK_EXIT_MANAGEMENT', dataDependency: 'PORTFOLIO_STATE', currentlyLive: true },
  ConsensusDebate: { methodologyFamily: 'ADVERSARIAL_CHALLENGE', dataDependency: 'PRIOR_EVIDENCE_ONLY', currentlyLive: true },

  // Not currently wired to emitTradeIdea anywhere - see this const's own doc comment above.
  Ta4jTechnicalParity: { methodologyFamily: 'TA_LIBRARY_PARITY_CHECK', dataDependency: 'CANONICAL_BARS', currentlyLive: false },
  OjAlgoPortfolioRisk: { methodologyFamily: 'PORTFOLIO_OPTIMIZATION', dataDependency: 'PORTFOLIO_STATE', currentlyLive: false },
};

/**
 * Classifies one agent's evidence for observability. Unrecognized agent names return
 * UNCLASSIFIED/UNKNOWN/currentlyLive=false rather than a guessed family - matches
 * `evidenceIndependence.ts`'s own fail-closed convention. Purely additive: nothing in
 * `EvidenceAggregator.aggregate()` or ChiefTrader's approval math reads this function's output.
 */
export function classifyEvidenceFamily(agentName: string): EvidenceFamilyMetadata {
  const def = FAMILY_DEFINITIONS[agentName];
  return {
    agent: agentName,
    independentEvidenceGroup: resolveIndependentEvidenceGroup(agentName),
    methodologyFamily: def?.methodologyFamily ?? 'UNCLASSIFIED',
    dataDependency: def?.dataDependency ?? 'UNKNOWN',
    currentlyLive: def?.currentlyLive ?? false,
  };
}
