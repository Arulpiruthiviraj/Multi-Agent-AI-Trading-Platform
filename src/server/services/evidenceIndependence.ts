/**
 * Evidence-independence grouping for ChiefTrader's minimum-independent-agent requirement
 * (2026-09-20 forensic-audit remediation).
 *
 * Prior behavior counted distinct AGENT NAMES as independent evidence
 * (`new Set(agreements.map(e => e.agent))`). That conflates WHO produced a vote with WHAT
 * underlying evidence the vote represents. Source-verified lineage:
 *
 * - `QuantEngine` (`QuantSignalAgent.ts`) emits one vote for `bestStrategyIdea()`'s pick among the
 *   5 CORE + enabled experimental TS strategies, evaluated over canonical bars.
 * - `JavaCoreEnsemble` (`JavaCoreEnsembleVoteService.ts`, backed by `CoreStrategyRunner.java`)
 *   independently recomputes the SAME 5 CORE strategies over the SAME canonical bars.
 *   `CoreStrategyRunner.java`'s own header states its strategy-family map is "copied verbatim from
 *   src/server/quant/strategyFamilies.ts's CORE_STRATEGY_FAMILIES ... so the correlation math ...
 *   is measuring the same families the TS side already uses" - i.e. this is not an independent
 *   model, it is the same 5-strategy computation in a second language.
 *
 * Two different implementations of the identical calculation over the identical inputs are not
 * two independent pieces of evidence - this is exactly CLAUDE.md's own standing rule ("correlated
 * strategies are not independent votes"), previously enforced only inside
 * `computeInternalEnsembleQualification()`'s correlation-adjusted qualification path and absent
 * from this raw count.
 *
 * `JavaFactorComposite` (`JavaQuantAdvisoryService.ts`) is deliberately NOT grouped with them: its
 * vote comes from `factorCompositeToVote()`, a GARCH/HMM-regime/5-factor Z-score composite
 * (`family: 'factor'` in `QuantCoreBridge.ts`'s `EnsembleModelVote`) - a different Java engine,
 * different features, different statistical model entirely, with no structural overlap found with
 * the CORE strategy ensemble in source. Absent verified structural overlap, it keeps its own
 * identity as an independent evidence group (fail-closed toward NOT assuming independence loss,
 * matching this module's evidence-only standard - grouping requires proof, not suspicion).
 *
 * Every other current agent (TechnicalAgent, NewsAgent, FundamentalAgent, MacroAgent,
 * KronosForecastAgent, OpportunityScreener, TradePlanBuilder, ConsensusDebate, ...) has no
 * established structural overlap with any other producer in this codebase - each keeps its own
 * agent name as its evidence group, byte-for-byte the prior behavior for every producer other than
 * the QuantEngine/JavaCoreEnsemble pair.
 *
 * This module intentionally does NOT attempt general empirical correlation (that remains
 * `QuantEnsembleEngine.java`'s separate, explicitly-declared-as-unmeasured
 * `defaultFamilyCorrelationMatrix()` concern, consumed only by the distinct
 * `computeInternalEnsembleQualification()` qualification path). It groups only where source proves
 * identical underlying computation, and never invents independence OR correlation beyond what is
 * actually traceable to a specific file/line.
 */

/** Shared evidence-group id for producers that recompute the same 5 CORE strategy ensemble. */
export const CORE_QUANT_ENSEMBLE_EVIDENCE_GROUP = 'CORE_QUANT_ENSEMBLE';

/** Agent names verified (see this file's header) to be structurally the same underlying
 *  CORE-strategy-ensemble computation over the same canonical bars, just in different languages.
 *
 *  2026-10-06 (Fast Lane -> Canonical Decision Spine Integration): `FastOpportunityLane`
 *  (`fastLaneEvaluator.ts`) added on the same evidentiary standard this file requires -
 *  structural proof, not suspicion. Its evaluator calls `quantSignalAgent.evaluateSymbol()`
 *  directly (the exact same function `QuantEngine`'s own live cycle calls), which runs the exact
 *  same `evaluateAll(strategyContext)` over the exact same canonical bars and picks via the exact
 *  same `bestStrategyIdea()`. There is no new feature computation, no new strategy, and no
 *  separate data path - Fast Lane is a latency/transport difference (event-driven vs. scheduled
 *  polling) around the identical underlying calculation, never an independent signal. Grouping it
 *  here is what prevents arrival-path alone from manufacturing a second independent vote out of
 *  one underlying piece of market evidence (the Fast Canonical Integration mandate's own stated
 *  principle). `FastOpportunityLane` does not currently emit any TRADE_IDEA_GENERATED (see
 *  fastLaneEvaluator.ts's own header - evaluation only, no emission in this phase) - this
 *  registration is correctness preparation for when a future, separately-authorized phase wires
 *  emission, not a behavior change today. */
const STRUCTURALLY_SAME_AS_CORE_QUANT_ENSEMBLE = new Set<string>(['QuantEngine', 'JavaCoreEnsemble', 'FastOpportunityLane']);

/**
 * Resolves the independent-evidence-group identity for one agreeing agent name. Two agreeing
 * pieces of evidence that resolve to the SAME group must count as ONE independent voice toward
 * `MIN_INDEPENDENT_AGREEING_AGENTS`, not two - they are the same underlying evidence source, not
 * two separate confirmations. Every agent not covered by a verified structural-overlap rule keeps
 * its own name as its group (fail-closed: no assumed correlation without source evidence).
 */
export function resolveIndependentEvidenceGroup(agentName: string): string {
  if (STRUCTURALLY_SAME_AS_CORE_QUANT_ENSEMBLE.has(agentName)) {
    return CORE_QUANT_ENSEMBLE_EVIDENCE_GROUP;
  }
  return agentName;
}
