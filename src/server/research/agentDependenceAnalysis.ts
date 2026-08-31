/**
 * Phase 10 (Agent Edge Discovery, 2026-08-31) - agent independence/dependence analysis.
 *
 * ARGUS's consensus policy requires >= 2 INDEPENDENT agreeing agents (minIndependentAgreeingAgents).
 * That requirement is only meaningful if two agents agreeing actually carries more information than
 * either agent alone. This module measures that directly from REAL agent_predictions +
 * prediction_outcomes data - never fabricated, never a live-path import.
 *
 * Statistical note: agent output here is categorical (BUY/SELL/HOLD), not a continuous variable, so
 * a Pearson correlation coefficient would be a statistically inappropriate tool (it assumes
 * continuous, roughly linear-relatable data). The appropriate real measure of "do these two agents
 * add information beyond either alone" is CONDITIONAL WIN RATE: when both agents fire on the same
 * symbol within the same real evaluation window and AGREE on direction, is the resulting win rate
 * (using either agent's own real outcome grading for that prediction - they reference the same
 * underlying price move when close in time) higher than EITHER agent's own unconditional win rate?
 * That excess is reported as "lift", with its own Wilson interval so a lift claim is never asserted
 * past what the sample size actually supports.
 */
import { db } from '../db';
import { agentPredictions, predictionOutcomes } from '../db/schema';
import { eq } from 'drizzle-orm';
import { wilsonInterval, classifyEvidenceStatus } from './effectiveSampleSize';
import { continuousIntelligence } from '../config/continuousIntelligence';
import { tradingSafety } from '../config/tradingSafety';
import { TELEMETRY_PULSE_TRACE_PREFIX } from '../core/telemetryPulse';

export const DEPENDENCE_PAIRS: Array<[string, string]> = [
  ['TechnicalAgent', 'QuantEngine'],
  ['TechnicalAgent', 'FundamentalAgent'],
  ['TechnicalAgent', 'MacroAgent'],
  ['QuantEngine', 'FundamentalAgent'],
  ['QuantEngine', 'MacroAgent'],
  ['FundamentalAgent', 'MacroAgent'],
];

export interface AgentPairDependence {
  agentA: string;
  agentB: string;
  coOccurrenceN: number;
  directionalAgreementN: number;
  directionalDisagreementN: number;
  /** Win rate when both agents fired on the same symbol within the co-occurrence window AND agreed on side. */
  agreementWinRate: number | null;
  agreementWilsonLower: number | null;
  agreementN: number;
  /** Each agent's own unconditional win rate, for comparison. */
  baselineWinRateA: number | null;
  baselineWinRateB: number | null;
  /** agreementWinRate - max(baselineA, baselineB); null when agreementN is too small to trust. */
  lift: number | null;
  sampleMaturity: 'INSUFFICIENT_EVIDENCE' | 'LEARNING_ELIGIBLE';
  status: 'INCREMENTAL_VALUE' | 'NO_INCREMENTAL_VALUE' | 'INSUFFICIENT_DATA';
}

interface Row {
  agentName: string;
  symbol: string;
  side: string;
  timestampMs: number;
  outcome: 'WIN' | 'LOSS' | 'N_A' | null;
}

async function fetchRows(): Promise<Row[]> {
  const preds = await db.select().from(agentPredictions).all();
  const outcomes = await db.select().from(predictionOutcomes).where(eq(predictionOutcomes.sourceTable, 'agent_predictions'));
  const outcomeByPredId = new Map(outcomes.map((o) => [o.predictionId, o]));
  return preds
    .filter((p) => !p.traceId || !p.traceId.startsWith(TELEMETRY_PULSE_TRACE_PREFIX))
    .map((p) => ({
      agentName: p.agentName, symbol: p.symbol, side: p.prediction,
      timestampMs: new Date(p.timestamp).getTime(),
      outcome: (outcomeByPredId.get(p.id)?.outcome as 'WIN' | 'LOSS' | 'N_A') ?? null,
    }));
}

function unconditionalWinRate(rows: Row[], agent: string): number | null {
  const graded = rows.filter((r) => r.agentName === agent && r.outcome && r.outcome !== 'N_A');
  if (graded.length === 0) return null;
  const wins = graded.filter((r) => r.outcome === 'WIN').length;
  return wins / graded.length;
}

/** Analyzes one ordered agent pair. windowMs bounds how close in time two predictions on the same
 *  symbol must be to count as the "same real evaluation episode" - reuses the same window
 *  recentCandidateRegistry already uses for same-candidate convergence, rather than inventing a new
 *  number. */
export function analyzePair(rows: Row[], agentA: string, agentB: string, windowMs: number): AgentPairDependence {
  const aRows = rows.filter((r) => r.agentName === agentA).sort((x, y) => x.timestampMs - y.timestampMs);
  const bRows = rows.filter((r) => r.agentName === agentB).sort((x, y) => x.timestampMs - y.timestampMs);

  let coOccurrenceN = 0;
  let agreementN = 0;
  let disagreementN = 0;
  let agreementWins = 0;
  let agreementGraded = 0;
  const usedB = new Set<number>();

  for (const a of aRows) {
    // Nearest same-symbol B prediction within the window, not already paired to an earlier A row.
    let bestIdx = -1;
    let bestGap = Infinity;
    for (let i = 0; i < bRows.length; i++) {
      if (usedB.has(i)) continue;
      const b = bRows[i];
      if (b.symbol !== a.symbol) continue;
      const gap = Math.abs(b.timestampMs - a.timestampMs);
      if (gap <= windowMs && gap < bestGap) {
        bestGap = gap;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) continue;
    const b = bRows[bestIdx];
    usedB.add(bestIdx);
    coOccurrenceN++;

    const aDirectional = a.side === 'BUY' || a.side === 'SELL';
    const bDirectional = b.side === 'BUY' || b.side === 'SELL';
    if (!aDirectional || !bDirectional) continue;

    if (a.side === b.side) {
      agreementN++;
      // Prefer A's own outcome grading; fall back to B's - both reference the same real price move
      // when this close in time, so either is a valid label for "did the agreed direction pay off".
      const outcome = (a.outcome && a.outcome !== 'N_A') ? a.outcome : b.outcome;
      if (outcome && outcome !== 'N_A') {
        agreementGraded++;
        if (outcome === 'WIN') agreementWins++;
      }
    } else {
      disagreementN++;
    }
  }

  const agreementInterval = wilsonInterval(agreementWins, agreementGraded);
  const baselineA = unconditionalWinRate(rows, agentA);
  const baselineB = unconditionalWinRate(rows, agentB);
  const sampleMaturity = classifyEvidenceStatus(agreementGraded, continuousIntelligence.championChallengerMinSampleSize);

  let lift: number | null = null;
  if (agreementInterval.pointEstimate !== null && baselineA !== null && baselineB !== null) {
    lift = agreementInterval.pointEstimate - Math.max(baselineA, baselineB);
  }

  let status: AgentPairDependence['status'] = 'INSUFFICIENT_DATA';
  if (sampleMaturity === 'LEARNING_ELIGIBLE' && agreementInterval.lower !== null && baselineA !== null && baselineB !== null) {
    // Only claim real incremental value when the LOWER bound of the agreement win rate still
    // clears the higher of the two single-agent baselines - a point-estimate lift alone is not
    // enough evidence, exactly per this mission's "do not label edge from raw point estimates" rule.
    status = agreementInterval.lower > Math.max(baselineA, baselineB) ? 'INCREMENTAL_VALUE' : 'NO_INCREMENTAL_VALUE';
  }

  return {
    agentA, agentB, coOccurrenceN,
    directionalAgreementN: agreementN, directionalDisagreementN: disagreementN,
    agreementWinRate: agreementInterval.pointEstimate, agreementWilsonLower: agreementInterval.lower,
    agreementN: agreementGraded,
    baselineWinRateA: baselineA, baselineWinRateB: baselineB,
    lift, sampleMaturity, status,
  };
}

export async function buildAgentDependenceReport(): Promise<AgentPairDependence[]> {
  const rows = await fetchRows();
  const windowMs = tradingSafety.recentCandidatePriorityMaxAgeMs;
  return DEPENDENCE_PAIRS.map(([a, b]) => analyzePair(rows, a, b, windowMs));
}

export function formatAgentDependenceReport(rows: AgentPairDependence[]): string {
  const lines = ['AGENT COMBINATION EDGE', '-----------------------', 'Pair'.padEnd(34) + 'CoOcc'.padEnd(8) + 'Agree'.padEnd(8) + 'AgreeWinRate'.padEnd(14) + 'BaselineMax'.padEnd(13) + 'Lift'.padEnd(9) + 'Status'];
  for (const r of rows) {
    const baselineMax = r.baselineWinRateA !== null && r.baselineWinRateB !== null ? Math.max(r.baselineWinRateA, r.baselineWinRateB) : null;
    lines.push(
      `${r.agentA}<->${r.agentB}`.padEnd(34)
      + String(r.coOccurrenceN).padEnd(8)
      + String(r.directionalAgreementN).padEnd(8)
      + (r.agreementWinRate !== null ? r.agreementWinRate.toFixed(3) : 'N/A').padEnd(14)
      + (baselineMax !== null ? baselineMax.toFixed(3) : 'N/A').padEnd(13)
      + (r.lift !== null ? (r.lift >= 0 ? '+' : '') + r.lift.toFixed(3) : 'N/A').padEnd(9)
      + r.status,
    );
  }
  return lines.join('\n');
}
