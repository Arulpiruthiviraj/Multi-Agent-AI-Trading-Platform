/**
 * Phase 12 (2026-08-31) - the exact strategy-selection replay this mission's Section 1/5/10 asks
 * for. Reuses the REAL production selection functions (never a hand-reimplemented approximation
 * of the formulas, which is what caused ambiguity in the prior pass) against real, already-
 * persisted quant_assessments.strategyEvaluations rows - the pre-ranking observation data that
 * already existed for every one of the 21 live strategies, every real quant cycle, regardless of
 * ranking outcome.
 *
 * For each historical cycle this replays the EXACT real chain QuantSignalAgent.evaluateSymbol()
 * itself runs: filterEvaluationsForStrategyFocus -> selectEvaluationsForAdaptiveRegime (the real
 * regime-preferred CORE-strategy-subset routing) -> rankEvaluationsForRegime (real ensembleScore =
 * setupScore * regimeRelevance * confidence) -> the real high-volatility confidence discount ->
 * bestStrategyIdea (the real MIN_STRATEGY_CONFIDENCE_TO_TRADE eligibility gate). This is
 * HISTORICAL REAL DATA replayed through CURRENT code - not a live probe, not a fabricated
 * scenario, and explicitly distinct from REAL LIVE agent_predictions ground truth (which this
 * module cross-references, never merges).
 */
import { db } from '../db';
import { quantAssessments, agentPredictions, predictionOutcomes } from '../db/schema';
import { eq, isNotNull } from 'drizzle-orm';
import { rankEvaluationsForRegime, deskIntelligence } from '../config/deskIntelligence';
import { filterEvaluationsForStrategyFocus, selectEvaluationsForAdaptiveRegime, normalizeStrategyFocus } from '../config/strategyFocus';
import { bestStrategyIdea, MIN_STRATEGY_CONFIDENCE_TO_TRADE, CORE_STRATEGIES } from '../quant/strategies/StrategyEngine';
import { secondaryGroupKey } from './predictionIndependencePolicy';
import { TELEMETRY_PULSE_TRACE_PREFIX } from '../core/telemetryPulse';

export interface StrategyFairnessRow {
  strategyId: string;
  isCore: boolean;
  /** Real cycles this strategy appeared in quant_assessments.strategyEvaluations (evaluated, real math, every cycle regardless of outcome). */
  totalEvaluations: number;
  /** Cleared MIN_STRATEGY_CONFIDENCE_TO_TRADE before the preferred-strategy boost. */
  eligibleEvaluations: number;
  /** Won rankEvaluationsForRegime's raw ensembleScore ranking among ALL 21 strategies this cycle. */
  rank1All21: number;
  /** Won ranking within its regime-preferred CORE subset (the pool that actually competes for real emission). */
  rank1Core: number;
  /** rank1Core AND cleared the real MIN_STRATEGY_CONFIDENCE_TO_TRADE eligibility gate - i.e. bestStrategyIdea() would have picked this strategy. HISTORICAL REAL DATA replayed through CURRENT code. */
  predictedWinner: number;
  /** Real, ground-truth emissions from agent_predictions (any variant: direct or *_COLD_START_BOOTSTRAP). REAL LIVE DATA. */
  realEmissions: number;
  /** Of realEmissions, how many have a real graded (WIN/LOSS) outcome. REAL LIVE DATA. */
  realGradedOutcomes: number;
  /** predictedWinner > 0 but realEmissions === 0: genuinely starved, not merely "never a good enough setup". */
  status: 'NEVER_EVALUATED' | 'EVALUATED_NEVER_SELECTED' | 'RANKED_BUT_INELIGIBLE' | 'SELECTED_NEVER_EMITTED' | 'EMITTED_NEVER_GRADED' | 'HAS_GRADED_EVIDENCE';
}

export async function buildStrategyFairnessReport(): Promise<StrategyFairnessRow[]> {
  const rows = await db.select().from(quantAssessments).where(isNotNull(quantAssessments.strategyEvaluations));
  const focusId = normalizeStrategyFocus('ADAPTIVE_MULTI_STRATEGY');
  const coreIds = new Set(CORE_STRATEGIES.map((s) => s.id));

  const stats: Record<string, { totalEvaluations: number; eligibleEvaluations: number; rank1All21: number; rank1Core: number; predictedWinner: number }> = {};

  for (const row of rows) {
    if (!row.strategyEvaluations) continue;
    let evals: any[]; let regimeObj: any;
    try {
      evals = JSON.parse(row.strategyEvaluations);
      regimeObj = JSON.parse(row.regime);
    } catch { continue; }
    if (!Array.isArray(evals) || evals.length === 0) continue;
    const regimeLabel = regimeObj?.regime ?? 'SIDEWAYS_RANGE';
    const volatility = regimeObj?.volatility ?? null;

    const rankedAll = rankEvaluationsForRegime(evals, regimeLabel);
    const rank1AllName = rankedAll[0]?.strategy;

    for (const e of evals) {
      if (!stats[e.strategy]) stats[e.strategy] = { totalEvaluations: 0, eligibleEvaluations: 0, rank1All21: 0, rank1Core: 0, predictedWinner: 0 };
      stats[e.strategy].totalEvaluations++;
      if (e.confidence >= MIN_STRATEGY_CONFIDENCE_TO_TRADE) stats[e.strategy].eligibleEvaluations++;
    }
    if (rank1AllName && stats[rank1AllName]) stats[rank1AllName].rank1All21++;

    const focused = filterEvaluationsForStrategyFocus(evals, focusId);
    const adapted = selectEvaluationsForAdaptiveRegime(focused, focusId, regimeLabel, volatility);
    const ranked = rankEvaluationsForRegime(adapted, regimeLabel);
    if (ranked[0] && stats[ranked[0].strategy]) stats[ranked[0].strategy].rank1Core++;

    const forPick = volatility === 'HIGH'
      ? ranked.map((e: any) => ({ ...e, confidence: Math.round(e.confidence * deskIntelligence.highVolatilityConfidenceMultiplier * 100) / 100 }))
      : ranked;
    const idea = bestStrategyIdea(forPick as any);
    if (idea && stats[idea.strategy]) stats[idea.strategy].predictedWinner++;
  }

  // Real ground truth: agent_predictions, attributed by secondaryGroupKey (the same attribution
  // fix from the prior pass) - a strategy's real emissions include BOTH its direct EV-backed rows
  // ("<id>") and its bootstrap-sourced rows ("<id>__COLD_START_BOOTSTRAP"), counted separately per
  // this mission's own "never mix populations silently" rule elsewhere, but summed here only for
  // the single yes/no "did this strategy ever really emit" fairness question.
  const preds = (await db.select().from(agentPredictions))
    .filter((p) => p.agentName === 'QuantEngine' && (!p.traceId || !p.traceId.startsWith(TELEMETRY_PULSE_TRACE_PREFIX)));
  const outcomes = await db.select().from(predictionOutcomes).where(eq(predictionOutcomes.sourceTable, 'agent_predictions'));
  const outcomeByPredId = new Map(outcomes.map((o) => [o.predictionId, o]));

  const emissionsByStrategy: Record<string, { emitted: number; graded: number }> = {};
  for (const p of preds) {
    const key = secondaryGroupKey('QuantEngine', p.reasoning);
    if (!key) continue;
    const realId = key.endsWith('__COLD_START_BOOTSTRAP') ? key.slice(0, -'__COLD_START_BOOTSTRAP'.length) : key;
    if (!emissionsByStrategy[realId]) emissionsByStrategy[realId] = { emitted: 0, graded: 0 };
    emissionsByStrategy[realId].emitted++;
    const outcome = outcomeByPredId.get(p.id)?.outcome;
    if (outcome && outcome !== 'N_A') emissionsByStrategy[realId].graded++;
  }

  const allIds = new Set([...Object.keys(stats), ...CORE_STRATEGIES.map((s) => s.id)]);
  const result: StrategyFairnessRow[] = [];
  for (const id of allIds) {
    const s = stats[id] ?? { totalEvaluations: 0, eligibleEvaluations: 0, rank1All21: 0, rank1Core: 0, predictedWinner: 0 };
    const emissions = emissionsByStrategy[id] ?? { emitted: 0, graded: 0 };
    // Real emitted/graded ground truth always takes priority over the quant_assessments-derived
    // evaluation count: a strategy can have real agent_predictions evidence even in a window where
    // this specific replay's quant_assessments scope didn't happen to capture its pre-ranking
    // evaluations (e.g. a different historical retention window) - never let an absence of one
    // signal override the presence of the other.
    // Real distinction (Phase 12, 2026-08-31): ranking #1 within the regime-preferred subset
    // (rank1Core) is NOT the same as bestStrategyIdea() actually selecting a strategy - that
    // function first filters by MIN_STRATEGY_CONFIDENCE_TO_TRADE, then picks the top-ranked
    // survivor (predictedWinner). A strategy can rank first every time its regime comes up yet
    // never once clear the confidence gate (e.g. MEAN_REVERSION: rank1Core > 0, predictedWinner
    // === 0) - that is genuinely "ranked but ineligible", not "selected" in the sense the real
    // code means it, and conflating the two would overstate how close it came to real emission.
    let status: StrategyFairnessRow['status'];
    if (emissions.graded > 0) status = 'HAS_GRADED_EVIDENCE';
    else if (emissions.emitted > 0) status = 'EMITTED_NEVER_GRADED';
    else if (s.totalEvaluations === 0) status = 'NEVER_EVALUATED';
    else if (s.predictedWinner > 0) status = 'SELECTED_NEVER_EMITTED';
    else if (s.rank1Core > 0) status = 'RANKED_BUT_INELIGIBLE';
    else status = 'EVALUATED_NEVER_SELECTED';

    result.push({
      strategyId: id, isCore: coreIds.has(id),
      totalEvaluations: s.totalEvaluations, eligibleEvaluations: s.eligibleEvaluations,
      rank1All21: s.rank1All21, rank1Core: s.rank1Core, predictedWinner: s.predictedWinner,
      realEmissions: emissions.emitted, realGradedOutcomes: emissions.graded,
      status,
    });
  }
  return result.sort((a, b) => (b.isCore ? 1 : 0) - (a.isCore ? 1 : 0) || b.predictedWinner - a.predictedWinner);
}

export function formatStrategyFairnessReport(rows: StrategyFairnessRow[]): string {
  const idWidth = Math.max(24, ...rows.map((r) => r.strategyId.length + 2));
  const lines = [
    'STRATEGY FAIRNESS (HISTORICAL REAL DATA replayed through CURRENT code, cross-referenced with REAL LIVE agent_predictions)',
    '----------------------------------------------------------------------------------------------------------------------',
    'Strategy'.padEnd(idWidth) + 'Core'.padEnd(6) + 'TotalEval'.padEnd(11) + 'Eligible'.padEnd(10) + 'Rank1/21'.padEnd(10) + 'Rank1Core'.padEnd(11) + 'PredictWin'.padEnd(12) + 'RealEmit'.padEnd(10) + 'Graded'.padEnd(8) + 'Status',
  ];
  for (const r of rows) {
    lines.push(
      r.strategyId.padEnd(idWidth)
      + (r.isCore ? 'YES' : 'no').padEnd(6)
      + String(r.totalEvaluations).padEnd(11)
      + String(r.eligibleEvaluations).padEnd(10)
      + String(r.rank1All21).padEnd(10)
      + String(r.rank1Core).padEnd(11)
      + String(r.predictedWinner).padEnd(12)
      + String(r.realEmissions).padEnd(10)
      + String(r.realGradedOutcomes).padEnd(8)
      + r.status,
    );
  }
  return lines.join('\n');
}
