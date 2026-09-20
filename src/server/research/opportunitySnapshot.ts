/**
 * Real Opportunity Snapshot (Institutional Transformation Mandate, Part 8/9 - "cross-sectional
 * opportunity ranking"). Composes ONLY already-real, already-measured numbers this codebase
 * already computes - no fabricated expected-return/probability-of-profit model, which would
 * require genuinely new Java quant calculation work (CLAUDE.md's Java 26 Engine Authority: "all
 * new quant/indicator/strategy calculation work goes to Java") that has not been done. Every field
 * here has real provenance: recent real QuantEngine ideas (agent_predictions.strategy_id, added
 * this session), real historical edge (agentEdgeAnalytics.ts), real multi-horizon forward-return
 * stats (multiHorizonOutcomeReport.ts, added this session), real strategy metadata
 * (strategyCatalog.ts, added this session), real portfolio correlation when a symbol is already
 * held (portfolioCorrelation work, added this session). This module invents nothing new - it is a
 * pure composition of five already-real reports, following this codebase's own established
 * "compose, don't duplicate" convention (strategyScorecard.ts is the precedent).
 *
 * Deliberately ranked by real evidence quality (evidenceClassification, then Wilson lower bound),
 * NEVER by a synthetic "opportunity score" - inventing a weighted formula over these real numbers
 * without a validated economic model behind it would be exactly the "not a fake score... every
 * component must be measurable" violation the mandate's own Part 8 warns against.
 */
import { db } from '../db';
import { agentPredictions, portfolio } from '../db/schema';
import { desc, eq, and, isNotNull } from 'drizzle-orm';
import { buildAgentEdgeReport, type AgentEdgeRow } from './agentEdgeAnalytics';
import { buildMultiHorizonSummaryReport, type MultiHorizonSummaryRow } from './multiHorizonOutcomeReport';
import { buildStrategyCatalog, type StrategyCatalogRow } from './strategyCatalog';
import { mostRecentForecast, type Forecast } from './forecastEngine';

export interface OpportunitySnapshotRow {
  traceId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  strategyId: string | null;
  generatedAt: string;
  /** Real setup confidence this specific idea was emitted with (agent_predictions.confidence). */
  ideaConfidence: number;
  strategyTier: 'CORE' | 'EXPERIMENTAL' | 'JAVA_RESEARCH' | null;
  strategyFamily: string | null;
  strategyLifecycleStatus: string | null;
  /** Real historical edge for this (QuantEngine, strategyId) pair - null if evidence is too thin
   *  (agentEdgeAnalytics.ts's own INSUFFICIENT_EVIDENCE classification, never fabricated).
   *  EV-backed (real strategy-sourced ideas) and cold-start-bootstrap-sourced ideas are two
   *  genuinely different evidence populations (predictionIndependencePolicy.ts's
   *  secondaryGroupKey()) and are NEVER merged - same "never mix populations silently" rule
   *  strategyReadiness.ts already established. Prefers evBacked when both exist. */
  historicalEdge: {
    variant: 'EV_BACKED' | 'COLD_START_BOOTSTRAP';
    rawN: number;
    effectiveN: number;
    winRate: number | null;
    wilsonLower: number | null;
    evidenceClassification: AgentEdgeRow['evidenceClassification'];
  } | null;
  /** Real mean forward return at each configured horizon for this strategy, from real graded
   *  outcomes - empty array if none graded yet. */
  forwardReturnByHorizon: Array<{ horizonLabel: string; n: number; meanForwardReturn: number; positiveReturnRate: number }>;
  /** True if this symbol is currently an open real position - portfolio-impact context, not a
   *  computed correlation number here (see GET /api/v2/portfolio/correlation for that). */
  alreadyHeld: boolean;
  /** Institutional Transformation Mandate Part 7/24 - the most recently PERSISTED forecast for
   *  this exact (symbol, agent=QuantEngine, strategyId, side) key, read directly from
   *  quant_forecasts (a bounded local DB read, never a live Java call from this hot path - see
   *  forecastEngine.ts's mostRecentForecast() for why). Null when no forecast has ever been built
   *  for this key - this is the correct, honest state for most rows today (forecasts are built
   *  on demand via `argus-cli forecast`, not yet on every opportunity-snapshot read). Clearly
   *  distinct from historicalEdge above: that field is OBSERVED/MEASURED (real past outcomes),
   *  this one is MODEL FORECAST (a statistical projection) - never conflate the two. */
  modelForecast: {
    forecastId: string;
    timestamp: string;
    status: Forecast['status'];
    expectedReturn: number | null;
    probabilityOfProfit: number | null;
    netExpectedReturn: number | null;
    sampleSize: number;
    /** Real strategy-diversity evidence (Part 7/9 integration, internalQuantEnsemble.ts) - null
     *  when the forecast was built without a real ensemble result for that cycle (e.g. an ad hoc
     *  CLI call, or the ensemble disagreed with this idea's side) - never fabricated. */
    strategyCount: number | null;
    familyCount: number | null;
    effectiveIndependentCount: number | null;
  } | null;
}

export async function buildOpportunitySnapshot(limit = 20): Promise<OpportunitySnapshotRow[]> {
  const recentIdeas = await db.select().from(agentPredictions)
    .where(and(
      eq(agentPredictions.agentName, 'QuantEngine'),
      isNotNull(agentPredictions.strategyId),
    ))
    .orderBy(desc(agentPredictions.timestamp))
    .limit(limit * 3); // over-fetch - BUY/SELL/HOLD all present; filtered below

  const directional = recentIdeas.filter((p) => p.prediction === 'BUY' || p.prediction === 'SELL').slice(0, limit);
  if (directional.length === 0) return [];

  const [edgeRows, horizonRows, catalogRows, heldPositions] = await Promise.all([
    buildAgentEdgeReport(),
    buildMultiHorizonSummaryReport('QuantEngine'),
    buildStrategyCatalog(),
    db.select().from(portfolio).all(),
  ]);

  // agentEdgeAnalytics.ts still derives its own strategy grouping from reasoning-text regex
  // (predictionIndependencePolicy.ts's secondaryGroupKey()), not yet from the real strategy_id
  // column added this session - the two agree on real production reasoning text today, but a
  // real strategy-sourced idea keys as either "<id>" (EV_BACKED) or "<id>__COLD_START_BOOTSTRAP"
  // (matching CLAUDE.md's own documented finding that essentially every current QuantEngine idea
  // is still cold-start, since zero organic closed trades exist yet) - both must be checked.
  const edgeByStrategy = new Map<string, AgentEdgeRow>();
  for (const r of edgeRows) {
    if (r.agentName === 'QuantEngine' && r.strategyId) edgeByStrategy.set(r.strategyId, r);
  }
  function lookupEdge(strategyId: string): { row: AgentEdgeRow; variant: 'EV_BACKED' | 'COLD_START_BOOTSTRAP' } | null {
    const evBacked = edgeByStrategy.get(strategyId);
    if (evBacked) return { row: evBacked, variant: 'EV_BACKED' };
    const bootstrap = edgeByStrategy.get(`${strategyId}__COLD_START_BOOTSTRAP`);
    if (bootstrap) return { row: bootstrap, variant: 'COLD_START_BOOTSTRAP' };
    return null;
  }
  const catalogByStrategy = new Map(catalogRows.map((r) => [r.strategyId, r]));
  const heldSymbols = new Set(heldPositions.filter((p) => (p.quantity || 0) !== 0).map((p) => p.symbol));
  const horizonByStrategy = new Map<string, MultiHorizonSummaryRow[]>();
  for (const r of horizonRows) {
    if (!r.strategyId) continue;
    const list = horizonByStrategy.get(r.strategyId) ?? [];
    list.push(r);
    horizonByStrategy.set(r.strategyId, list);
  }

  const rows: OpportunitySnapshotRow[] = await Promise.all(directional.map(async (p) => {
    const strategyId = p.strategyId!;
    const edge = lookupEdge(strategyId);
    const catalog: StrategyCatalogRow | undefined = catalogByStrategy.get(strategyId);
    const horizons = horizonByStrategy.get(strategyId) ?? [];
    const forecast = await mostRecentForecast(p.symbol, 'QuantEngine', strategyId, p.prediction as 'BUY' | 'SELL');
    return {
      traceId: p.traceId ?? '',
      symbol: p.symbol,
      side: p.prediction as 'BUY' | 'SELL',
      strategyId,
      generatedAt: p.timestamp,
      ideaConfidence: p.confidence,
      strategyTier: catalog?.tier ?? null,
      strategyFamily: catalog?.family ?? null,
      strategyLifecycleStatus: catalog?.lifecycleStatus ?? null,
      historicalEdge: edge ? {
        variant: edge.variant,
        rawN: edge.row.rawN, effectiveN: edge.row.effectiveN, winRate: edge.row.winRate, wilsonLower: edge.row.wilsonLower,
        evidenceClassification: edge.row.evidenceClassification,
      } : null,
      forwardReturnByHorizon: horizons
        .sort((a, b) => a.horizonBars - b.horizonBars)
        .map((h) => ({ horizonLabel: h.horizonLabel, n: h.n, meanForwardReturn: h.meanForwardReturn, positiveReturnRate: h.positiveReturnRate })),
      alreadyHeld: heldSymbols.has(p.symbol),
      modelForecast: forecast ? {
        forecastId: forecast.forecastId, timestamp: forecast.timestamp, status: forecast.status,
        expectedReturn: forecast.expectedReturn, probabilityOfProfit: forecast.probabilityOfProfit,
        netExpectedReturn: forecast.netExpectedReturn, sampleSize: forecast.sampleSize,
        strategyCount: forecast.strategyCount, familyCount: forecast.familyCount,
        effectiveIndependentCount: forecast.effectiveIndependentCount,
      } : null,
    };
  }));

  // Real-evidence ranking only - EDGE_SUPPORTED first, then by Wilson lower bound descending.
  // Never a synthetic weighted score (see this file's own header comment for why).
  const classificationRank: Record<AgentEdgeRow['evidenceClassification'], number> = {
    EDGE_SUPPORTED: 0, NO_EDGE: 1, INSUFFICIENT_EVIDENCE: 2, EDGE_DISPROVEN: 3,
  };
  rows.sort((a, b) => {
    const ra = a.historicalEdge ? classificationRank[a.historicalEdge.evidenceClassification] : 2;
    const rb = b.historicalEdge ? classificationRank[b.historicalEdge.evidenceClassification] : 2;
    if (ra !== rb) return ra - rb;
    const wa = a.historicalEdge?.wilsonLower ?? -1;
    const wb = b.historicalEdge?.wilsonLower ?? -1;
    return wb - wa;
  });

  return rows;
}

export function formatOpportunitySnapshot(rows: OpportunitySnapshotRow[]): string {
  const symbolWidth = Math.max(10, ...rows.map((r) => r.symbol.length + 2));
  const strategyWidth = Math.max(24, ...rows.map((r) => (r.strategyId ?? '').length + 2));
  const lines = [
    'REAL OPPORTUNITY SNAPSHOT (evidence-ranked, no fabricated score)', '-------------------------------------------------------------',
    'Symbol'.padEnd(symbolWidth) + 'Side'.padEnd(6) + 'Strategy'.padEnd(strategyWidth) + 'Tier'.padEnd(14) + 'Variant'.padEnd(20) + 'N'.padEnd(6) + 'WinRate'.padEnd(10) + 'WilsonLo'.padEnd(10) + 'Evidence'.padEnd(20) + 'Forecast(ExpRet/PoP)'.padEnd(22) + 'EffIndep(fam)'.padEnd(15) + 'Held',
  ];
  for (const r of rows) {
    const forecastCol = !r.modelForecast ? 'NO_FORECAST'
      : r.modelForecast.status !== 'VALID' ? r.modelForecast.status
      : `${r.modelForecast.expectedReturn === null ? 'UNKNOWN' : `${(r.modelForecast.expectedReturn * 100).toFixed(2)}%`}/${r.modelForecast.probabilityOfProfit === null ? 'UNKNOWN' : `${(r.modelForecast.probabilityOfProfit * 100).toFixed(0)}%`}`;
    // Real strategy-diversity evidence (Part 7/9) - UNKNOWN, never a fabricated count, when the
    // forecast carries none (ad hoc call, or an ensemble that disagreed with this idea's side).
    const diversityCol = !r.modelForecast || r.modelForecast.effectiveIndependentCount === null
      ? 'UNKNOWN'
      : `${r.modelForecast.effectiveIndependentCount.toFixed(1)}(${r.modelForecast.familyCount ?? '?'})`;
    lines.push(
      r.symbol.padEnd(symbolWidth)
      + r.side.padEnd(6)
      + (r.strategyId ?? '(none)').padEnd(strategyWidth)
      + (r.strategyTier ?? '-').padEnd(14)
      + (r.historicalEdge?.variant ?? '-').padEnd(20)
      + String(r.historicalEdge?.effectiveN ?? 0).padEnd(6)
      + (r.historicalEdge?.winRate !== null && r.historicalEdge?.winRate !== undefined ? r.historicalEdge.winRate.toFixed(3) : 'N/A').padEnd(10)
      + (r.historicalEdge?.wilsonLower !== null && r.historicalEdge?.wilsonLower !== undefined ? r.historicalEdge.wilsonLower.toFixed(3) : 'N/A').padEnd(10)
      + (r.historicalEdge?.evidenceClassification ?? 'INSUFFICIENT_EVIDENCE').padEnd(20)
      + forecastCol.padEnd(22)
      + diversityCol.padEnd(15)
      + (r.alreadyHeld ? 'YES' : 'no'),
    );
  }
  return lines.join('\n');
}
