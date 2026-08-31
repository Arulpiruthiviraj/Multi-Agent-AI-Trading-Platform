/**
 * Phase 10 (Agent Edge Discovery & Strategy Validation, 2026-08-31). Per-agent (and, where a real
 * sub-identity exists - QuantEngine strategies - per agent+strategy) predictive-edge analytics
 * computed from REAL agent_predictions/kronos_predictions + prediction_outcomes rows only. Reuses
 * the existing effective-sample-size clustering (effectiveSampleSize.ts) and per-agent
 * independence policy (predictionIndependencePolicy.ts) rather than re-deriving either - this
 * module is a NEW aggregation lens over data those two already make statistically defensible, not
 * a new statistics engine.
 *
 * Never touches agent_confidence_calibration or learning_versions (read-only, observational).
 * Never imports ChiefTraderAgent/RiskEngine/OMS/BrokerManager.
 */
import { db } from '../db';
import { agentPredictions, predictionOutcomes, kronosPredictions } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { clusterByTimeGap, wilsonInterval, classifyEvidenceStatus, type ClusterableRow } from './effectiveSampleSize';
import { independenceClusterGapMs, secondaryGroupKey, isExcludedFromWeightLearning } from './predictionIndependencePolicy';
import { continuousIntelligence } from '../config/continuousIntelligence';
import { TELEMETRY_PULSE_TRACE_PREFIX } from '../core/telemetryPulse';

export interface AgentEdgeRow {
  agentName: string;
  /** Real QuantEngine strategy id (from secondaryGroupKey), or null for the agent's overall row. */
  strategyId: string | null;
  rawN: number;
  effectiveN: number;
  winRate: number | null;
  wilsonLower: number | null;
  wilsonUpper: number | null;
  brierScore: number | null;
  buyRate: number;
  sellRate: number;
  holdRate: number;
  /** HOLD-at-zero-confidence (DATA_UNAVAILABLE shape) as a share of ALL rows, directional or not. */
  abstentionRate: number;
  sampleMaturity: 'INSUFFICIENT_EVIDENCE' | 'LEARNING_ELIGIBLE';
  statisticalStatus: 'NO_EDGE_DETECTABLE' | 'BELOW_CHANCE' | 'ABOVE_CHANCE';
  excludedFromWeightLearning: boolean;
}

interface FetchedRow {
  agentName: string;
  symbol: string;
  side: string;
  confidence: number;
  timestampMs: number;
  reasoning: string | null;
  outcome: 'WIN' | 'LOSS' | 'N_A' | null;
  actualDirection: string | null;
}

async function fetchAllRows(): Promise<FetchedRow[]> {
  const preds = await db.select().from(agentPredictions).all();
  const outcomes = await db.select().from(predictionOutcomes).where(eq(predictionOutcomes.sourceTable, 'agent_predictions'));
  const outcomeByPredId = new Map(outcomes.map((o) => [o.predictionId, o]));

  const rows: FetchedRow[] = [];
  for (const p of preds) {
    if (p.traceId && p.traceId.startsWith(TELEMETRY_PULSE_TRACE_PREFIX)) continue;
    const o = outcomeByPredId.get(p.id);
    rows.push({
      agentName: p.agentName, symbol: p.symbol, side: p.prediction, confidence: p.confidence,
      timestampMs: new Date(p.timestamp).getTime(), reasoning: p.reasoning,
      outcome: o ? (o.outcome as 'WIN' | 'LOSS' | 'N_A') : null,
      actualDirection: o?.actualDirection ?? null,
    });
  }

  const kronosRows = await db.select().from(kronosPredictions);
  const kronosOutcomes = await db.select().from(predictionOutcomes).where(eq(predictionOutcomes.sourceTable, 'kronos_predictions'));
  const kronosOutcomeById = new Map(kronosOutcomes.map((o) => [o.predictionId, o]));
  for (const k of kronosRows) {
    const o = kronosOutcomeById.get(String(k.id));
    rows.push({
      agentName: 'KronosEngine', symbol: k.symbol, side: k.prediction, confidence: k.confidence,
      timestampMs: new Date(k.timestamp).getTime(), reasoning: null,
      outcome: o ? (o.outcome as 'WIN' | 'LOSS' | 'N_A') : null,
      actualDirection: o?.actualDirection ?? null,
    });
  }
  return rows;
}

function toClusterable(rows: FetchedRow[]): ClusterableRow[] {
  return rows.filter((r) => r.outcome !== null).map((r) => ({
    symbol: r.symbol, agent: r.agentName, side: r.side, timestampMs: r.timestampMs,
    outcome: r.outcome as 'WIN' | 'LOSS' | 'N_A',
    secondaryKey: secondaryGroupKey(r.agentName, r.reasoning) ?? undefined,
  }));
}

function computeGroup(agentName: string, strategyId: string | null, allRows: FetchedRow[]): AgentEdgeRow {
  const scoped = strategyId === null
    ? allRows.filter((r) => r.agentName === agentName)
    : allRows.filter((r) => r.agentName === agentName && secondaryGroupKey(agentName, r.reasoning) === strategyId);

  const total = scoped.length;
  const buyN = scoped.filter((r) => r.side === 'BUY').length;
  const sellN = scoped.filter((r) => r.side === 'SELL').length;
  const holdN = scoped.filter((r) => r.side === 'HOLD').length;
  const abstentionN = scoped.filter((r) => r.side === 'HOLD' && r.confidence === 0).length;

  const graded = scoped.filter((r) => r.outcome !== null && r.outcome !== 'N_A');
  const clusterable = toClusterable(scoped);
  const gapMs = independenceClusterGapMs(agentName);
  const clusters = clusterByTimeGap(clusterable, gapMs).filter((c) => c.outcome !== 'N_A');
  const effectiveN = clusters.length;
  const effectiveWins = clusters.filter((c) => c.outcome === 'WIN').length;
  const interval = wilsonInterval(effectiveWins, effectiveN);

  // Brier score: (confidence - outcome)^2 averaged over graded, directional predictions - confidence
  // is already the agent's own stated win-probability-like scalar (0-1), and outcome is 1 for WIN,
  // 0 for LOSS. Lower is better; 0.25 is the "always guess 50%" baseline.
  let brierScore: number | null = null;
  if (graded.length > 0) {
    const sum = graded.reduce((acc, r) => {
      const actual = r.outcome === 'WIN' ? 1 : 0;
      return acc + (r.confidence - actual) ** 2;
    }, 0);
    brierScore = sum / graded.length;
  }

  const sampleMaturity = classifyEvidenceStatus(effectiveN, continuousIntelligence.championChallengerMinSampleSize);
  let statisticalStatus: AgentEdgeRow['statisticalStatus'] = 'NO_EDGE_DETECTABLE';
  if (sampleMaturity === 'LEARNING_ELIGIBLE' && interval.lower !== null) {
    if (interval.lower > 0.5) statisticalStatus = 'ABOVE_CHANCE';
    else if (interval.upper !== null && interval.upper < 0.5) statisticalStatus = 'BELOW_CHANCE';
  }

  return {
    agentName, strategyId,
    rawN: graded.length, effectiveN,
    winRate: interval.pointEstimate, wilsonLower: interval.lower, wilsonUpper: interval.upper,
    brierScore,
    buyRate: total > 0 ? buyN / total : 0,
    sellRate: total > 0 ? sellN / total : 0,
    holdRate: total > 0 ? holdN / total : 0,
    abstentionRate: total > 0 ? abstentionN / total : 0,
    sampleMaturity, statisticalStatus,
    excludedFromWeightLearning: isExcludedFromWeightLearning(agentName),
  };
}

/** Every agent's overall edge row, plus one extra row per real QuantEngine strategy id observed. */
export async function buildAgentEdgeReport(): Promise<AgentEdgeRow[]> {
  const allRows = await fetchAllRows();
  const agents = Array.from(new Set(allRows.map((r) => r.agentName))).sort();

  const results: AgentEdgeRow[] = [];
  for (const agent of agents) {
    results.push(computeGroup(agent, null, allRows));
    const strategyIds = new Set<string>();
    for (const r of allRows) {
      if (r.agentName !== agent) continue;
      const key = secondaryGroupKey(agent, r.reasoning);
      if (key) strategyIds.add(key);
    }
    for (const strategyId of Array.from(strategyIds).sort()) {
      results.push(computeGroup(agent, strategyId, allRows));
    }
  }
  return results;
}

export function formatAgentEdgeReport(rows: AgentEdgeRow[]): string {
  const lines = ['AGENT EDGE', '----------', 'Agent'.padEnd(24) + 'Strategy'.padEnd(24) + 'N'.padEnd(8) + 'EffN'.padEnd(8) + 'WinRate'.padEnd(10) + 'WilsonLo'.padEnd(10) + 'Brier'.padEnd(8) + 'Status'];
  for (const r of rows) {
    lines.push(
      r.agentName.padEnd(24)
      + (r.strategyId ?? '(overall)').padEnd(24)
      + String(r.rawN).padEnd(8)
      + String(r.effectiveN).padEnd(8)
      + (r.winRate !== null ? r.winRate.toFixed(3) : 'N/A').padEnd(10)
      + (r.wilsonLower !== null ? r.wilsonLower.toFixed(3) : 'N/A').padEnd(10)
      + (r.brierScore !== null ? r.brierScore.toFixed(3) : 'N/A').padEnd(8)
      + r.statisticalStatus,
    );
  }
  return lines.join('\n');
}
