/**
 * ConsensusDebate Health Report (P0.5 forensic measurement, 2026-09-13). Read-only aggregate over
 * consensus_debate_predictions + prediction_outcomes (sourceTable = 'consensus_debate_predictions'),
 * answering the mandate's central question: DOES CONSENSUSDEBATE ADD OR DESTROY ECONOMIC VALUE?
 * OBSERVATION ONLY - this module has no write path back into ChiefTraderAgent, RiskEngine, OMS, or
 * agent_performance_stats. Same JS-side full-table-read + grouping convention this codebase's other
 * real aggregators use (agentEdgeAnalytics.ts), not a new query style.
 *
 * Scope note: grades baseConsensusSide (the candidate ConsensusDebate voted on), not
 * debateDirection itself - directional (BUY/SELL) debate votes are rare (~3.6% of participations in
 * the initial live audit) and a second grading path for debate's own directional accuracy is a real,
 * deliberately-deferred follow-up, not a silent omission.
 */
import { db } from '../db';
import { consensusDebatePredictions, predictionOutcomes } from '../db/schema';
import { eq } from 'drizzle-orm';
import { researchSafety } from '../config/researchSafety';

const SOURCE_TABLE = 'consensus_debate_predictions';
const CONFIDENCE_BUCKETS: Array<[number, number]> = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.0]];

export type DebateRecommendation =
  | 'INSUFFICIENT_DATA'
  | 'POSITIVE_INCREMENTAL_VALUE'
  | 'NEUTRAL_INCREMENTAL_VALUE'
  | 'NEGATIVE_INCREMENTAL_VALUE'
  | 'UNSTABLE_VALUE'
  | 'UNRELIABLE_PREDICTOR';

export interface ConsensusDebateHealthReport {
  windowStartIso: string | null;
  usage: {
    totalCaptured: number;
    validPredictions: number;
    failClosedNoRoute: number;
    failClosedError: number;
    failClosedNoVerdict: number;
    failClosedRate: number | null;
  };
  directionDistribution: { BUY: number; SELL: number; HOLD: number };
  /** vetoFired rows: debate's HOLD was the (or a) reason an otherwise-qualifying round did not approve. */
  vetoStats: {
    vetoFiredCount: number;
    gradedCount: number;
    goodVetoCount: number; // graded forwardReturn < 0 - the vetoed candidate would have lost
    badVetoCount: number; // graded forwardReturn > 0 - the vetoed candidate would have won
    vetoPrecision: number | null; // goodVeto / (goodVeto + badVeto)
    avgReturnAvoided: number | null; // mean forwardReturn over GOOD_VETO rows (negative)
    avgReturnDestroyed: number | null; // mean forwardReturn over BAD_VETO rows (positive)
    /** Sum of forwardReturn across every graded vetoed candidate. Negative = net-destructive
     *  (debate blocked more value than it protected); positive = net-protective. THE central
     *  number this whole measurement exists to produce. */
    netEconomicValueOfVetoes: number | null;
  };
  confidenceBuckets: Array<{ bucketLow: number; bucketHigh: number; n: number; goodVetoRate: number | null }>;
  /** Keyed by real config/tradingSafety.json marketRegime strings captured at decision time; null-regime rows grouped under '(unknown)'. */
  regimeBreakdown: Array<{ regime: string; n: number; netEconomicValue: number | null }>;
  sampleSize: number;
  recommendation: DebateRecommendation;
  recommendationReason: string;
}

interface JoinedRow {
  vetoFired: boolean;
  debateDirection: string | null;
  debateConfidence: number | null;
  marketRegime: string | null;
  forwardReturn: number | null; // from prediction_outcomes, null if not yet graded
}

export async function buildConsensusDebateHealthReport(sinceIso?: string): Promise<ConsensusDebateHealthReport> {
  const allRows = sinceIso
    ? (await db.select().from(consensusDebatePredictions)).filter((r) => r.createdAt >= sinceIso)
    : await db.select().from(consensusDebatePredictions);

  const outcomes = await db.select().from(predictionOutcomes).where(eq(predictionOutcomes.sourceTable, SOURCE_TABLE));
  const outcomeByPredictionId = new Map(outcomes.map((o) => [o.predictionId, o]));

  const validRows = allRows.filter((r) => r.debateStatus === 'VALID_PREDICTION');
  const failClosedNoRoute = allRows.filter((r) => r.debateStatus === 'FAIL_CLOSED_NO_ROUTE').length;
  const failClosedError = allRows.filter((r) => r.debateStatus === 'FAIL_CLOSED_ERROR').length;
  const failClosedNoVerdict = allRows.filter((r) => r.debateStatus === 'FAIL_CLOSED_NO_VERDICT').length;
  const totalFailClosed = failClosedNoRoute + failClosedError + failClosedNoVerdict;

  const directionDistribution = { BUY: 0, SELL: 0, HOLD: 0 };
  for (const r of validRows) {
    if (r.debateDirection === 'BUY') directionDistribution.BUY++;
    else if (r.debateDirection === 'SELL') directionDistribution.SELL++;
    else if (r.debateDirection === 'HOLD') directionDistribution.HOLD++;
  }

  const joined: JoinedRow[] = validRows.map((r) => ({
    vetoFired: r.vetoFired,
    debateDirection: r.debateDirection,
    debateConfidence: r.debateConfidence,
    marketRegime: r.marketRegime,
    forwardReturn: outcomeByPredictionId.get(r.id)?.actualReturn ?? null,
  }));

  const vetoedRows = joined.filter((r) => r.vetoFired);
  const gradedVetoedRows = vetoedRows.filter((r) => r.forwardReturn !== null);
  const goodVetoRows = gradedVetoedRows.filter((r) => (r.forwardReturn as number) < 0);
  const badVetoRows = gradedVetoedRows.filter((r) => (r.forwardReturn as number) > 0);
  const netEconomicValueOfVetoes = gradedVetoedRows.length > 0
    ? gradedVetoedRows.reduce((s, r) => s + (r.forwardReturn as number), 0)
    : null;

  const vetoStats = {
    vetoFiredCount: vetoedRows.length,
    gradedCount: gradedVetoedRows.length,
    goodVetoCount: goodVetoRows.length,
    badVetoCount: badVetoRows.length,
    vetoPrecision: (goodVetoRows.length + badVetoRows.length) > 0
      ? goodVetoRows.length / (goodVetoRows.length + badVetoRows.length)
      : null,
    avgReturnAvoided: goodVetoRows.length > 0
      ? goodVetoRows.reduce((s, r) => s + (r.forwardReturn as number), 0) / goodVetoRows.length
      : null,
    avgReturnDestroyed: badVetoRows.length > 0
      ? badVetoRows.reduce((s, r) => s + (r.forwardReturn as number), 0) / badVetoRows.length
      : null,
    netEconomicValueOfVetoes,
  };

  const confidenceBuckets = CONFIDENCE_BUCKETS.map(([lo, hi]) => {
    const inBucket = gradedVetoedRows.filter((r) =>
      r.debateConfidence !== null && r.debateConfidence >= lo && (hi === 1.0 ? r.debateConfidence <= hi : r.debateConfidence < hi));
    const good = inBucket.filter((r) => (r.forwardReturn as number) < 0).length;
    const total = good + inBucket.filter((r) => (r.forwardReturn as number) > 0).length;
    return { bucketLow: lo, bucketHigh: hi, n: inBucket.length, goodVetoRate: total > 0 ? good / total : null };
  });

  const regimeGroups = new Map<string, JoinedRow[]>();
  for (const r of gradedVetoedRows) {
    const key = r.marketRegime ?? '(unknown)';
    const list = regimeGroups.get(key) ?? [];
    list.push(r);
    regimeGroups.set(key, list);
  }
  const regimeBreakdown = Array.from(regimeGroups.entries()).map(([regime, rows]) => ({
    regime,
    n: rows.length,
    netEconomicValue: rows.reduce((s, r) => s + (r.forwardReturn as number), 0),
  })).sort((a, b) => b.n - a.n);

  const minSample = researchSafety.minOosTrades; // reuse the existing, already-reviewed OOS floor - not a new invented number
  let recommendation: DebateRecommendation;
  let recommendationReason: string;
  if (gradedVetoedRows.length < minSample) {
    recommendation = 'INSUFFICIENT_DATA';
    recommendationReason = `Only ${gradedVetoedRows.length} graded vetoed candidates so far (need >= ${minSample}, config/researchSafety.json minOosTrades) - continue paper observation before drawing any conclusion.`;
  } else if (netEconomicValueOfVetoes === null) {
    recommendation = 'INSUFFICIENT_DATA';
    recommendationReason = 'No graded vetoed candidates yet.';
  } else {
    const meanNetValue = netEconomicValueOfVetoes / gradedVetoedRows.length;
    if (Math.abs(meanNetValue) < 0.001) {
      recommendation = 'NEUTRAL_INCREMENTAL_VALUE';
      recommendationReason = `Mean net return per vetoed candidate (${(meanNetValue * 100).toFixed(3)}%) is close to zero - ConsensusDebate is neither clearly protective nor clearly destructive.`;
    } else if (meanNetValue > 0) {
      recommendation = 'POSITIVE_INCREMENTAL_VALUE';
      recommendationReason = `Mean net return per vetoed candidate is ${(meanNetValue * 100).toFixed(3)}% (positive = avoided losses outweigh missed gains) over ${gradedVetoedRows.length} graded vetoes.`;
    } else {
      recommendation = 'NEGATIVE_INCREMENTAL_VALUE';
      recommendationReason = `Mean net return per vetoed candidate is ${(meanNetValue * 100).toFixed(3)}% (negative = ConsensusDebate is blocking more value than it protects) over ${gradedVetoedRows.length} graded vetoes.`;
    }
  }

  return {
    windowStartIso: sinceIso ?? null,
    usage: {
      totalCaptured: allRows.length,
      validPredictions: validRows.length,
      failClosedNoRoute,
      failClosedError,
      failClosedNoVerdict,
      failClosedRate: allRows.length > 0 ? totalFailClosed / allRows.length : null,
    },
    directionDistribution,
    vetoStats,
    confidenceBuckets,
    regimeBreakdown,
    sampleSize: gradedVetoedRows.length,
    recommendation,
    recommendationReason,
  };
}

export function formatConsensusDebateHealthReport(r: ConsensusDebateHealthReport): string {
  const lines = [
    'CONSENSUS DEBATE HEALTH REPORT', '------------------------------',
    `Window: ${r.windowStartIso ?? '(all time)'}`,
    '',
    '-- Usage & Reliability --',
    `Total captured: ${r.usage.totalCaptured} | Valid predictions: ${r.usage.validPredictions} | Fail-closed: ${r.usage.failClosedNoRoute + r.usage.failClosedError + r.usage.failClosedNoVerdict} (rate ${r.usage.failClosedRate !== null ? (r.usage.failClosedRate * 100).toFixed(1) + '%' : 'N/A'})`,
    `  no-route=${r.usage.failClosedNoRoute} error=${r.usage.failClosedError} no-verdict=${r.usage.failClosedNoVerdict}`,
    '',
    '-- Direction Distribution --',
    `BUY=${r.directionDistribution.BUY} SELL=${r.directionDistribution.SELL} HOLD=${r.directionDistribution.HOLD}`,
    '',
    '-- HOLD-Veto Analysis (the central question) --',
    `Vetoes fired: ${r.vetoStats.vetoFiredCount} | Graded: ${r.vetoStats.gradedCount}`,
    `Good vetoes (would have lost): ${r.vetoStats.goodVetoCount} | Bad vetoes (would have won): ${r.vetoStats.badVetoCount}`,
    `Veto precision: ${r.vetoStats.vetoPrecision !== null ? (r.vetoStats.vetoPrecision * 100).toFixed(1) + '%' : 'N/A'}`,
    `Avg return avoided: ${r.vetoStats.avgReturnAvoided !== null ? (r.vetoStats.avgReturnAvoided * 100).toFixed(3) + '%' : 'N/A'}`,
    `Avg return destroyed: ${r.vetoStats.avgReturnDestroyed !== null ? (r.vetoStats.avgReturnDestroyed * 100).toFixed(3) + '%' : 'N/A'}`,
    `NET ECONOMIC VALUE OF VETOES: ${r.vetoStats.netEconomicValueOfVetoes !== null ? (r.vetoStats.netEconomicValueOfVetoes * 100).toFixed(3) + '%' : 'N/A'}`,
    '',
    '-- Confidence Buckets (goodVetoRate) --',
    ...r.confidenceBuckets.map((b) => `  [${b.bucketLow.toFixed(2)}-${b.bucketHigh.toFixed(2)}) n=${b.n} goodVetoRate=${b.goodVetoRate !== null ? (b.goodVetoRate * 100).toFixed(1) + '%' : 'N/A'}`),
    '',
    '-- Regime Breakdown --',
    ...r.regimeBreakdown.map((rb) => `  ${rb.regime.padEnd(20)} n=${rb.n} netEconomicValue=${rb.netEconomicValue !== null ? (rb.netEconomicValue * 100).toFixed(3) + '%' : 'N/A'}`),
    '',
    `RECOMMENDATION: ${r.recommendation}`,
    r.recommendationReason,
  ];
  return lines.join('\n');
}
