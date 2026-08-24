/**
 * ModelPerformanceTracker foundations - real predicted-vs-realized tracking for Java quant models
 * in SHADOW, reusing the EXISTING, already-running agent_predictions / prediction_outcomes /
 * PredictionOutcomeEvaluator / ReflectionEngine pipeline (src/server/services/ReflectionEngine.ts,
 * PredictionOutcomeEvaluator.ts) rather than building a second, parallel prediction ledger.
 *
 * CRITICAL SAFETY NOTE - read before changing anything here: ReflectionEngine's own
 * agent_predictions rows are written from a live EventBus subscription to TRADE_IDEA_GENERATED
 * (see its constructor: `eventBus.on('TRADE_IDEA_GENERATED', ...)`). That event is exactly what
 * ChiefTraderAgent/EvidenceAggregator consume as a real, voting trade idea. recordPrediction()
 * below therefore writes DIRECTLY to the agentPredictions table - it does NOT emit
 * TRADE_IDEA_GENERATED and must never be changed to do so, or every Java SHADOW model would
 * silently become a live ChiefTrader vote source, exactly the boundary this whole institutional
 * activation effort has been careful to keep advisory-only. The existing
 * PredictionOutcomeEvaluator.evaluatePending() and ReflectionEngine's stats aggregation both
 * already query agent_predictions directly (not the event), so a row written this way is picked
 * up, graded, and rolled into agent_performance_stats (win rate, Sharpe, effective sample size)
 * exactly like any other agent's predictions - automatically, with zero new evaluation logic.
 *
 * What IS new here: regime-segmented hit rates. agent_predictions already has a `regime` column,
 * but ReflectionEngine's own aggregation never breaks stats down by it (confirmed by reading that
 * file - regime is captured at write time and otherwise unused). getRegimeSegmentedStats() below
 * is the first real consumer of that column for a segmented view - the empirical foundation the
 * institutional activation plan needs before RegimeVolatilityOverlay's declared regimeSuitability
 * constants could ever be replaced with measured values.
 */
import crypto from 'crypto';
import { db } from '../db';
import { agentPredictions, predictionOutcomes } from '../db/schema';
import { eq } from 'drizzle-orm';

export type RecordablePredictionSide = 'BUY' | 'SELL' | 'HOLD';

export interface RecordPredictionInput {
  agentName: string;
  symbol: string;
  side: RecordablePredictionSide;
  confidence: number;
  reasoning: string;
  regime?: string | null;
  traceId?: string | null;
  timestamp?: string;
}

/** Direct insert into the existing agentPredictions table - see the module header for why this never goes through TRADE_IDEA_GENERATED. Fails closed (logs, never throws) - a tracking failure must never affect anything upstream. */
export async function recordPrediction(input: RecordPredictionInput): Promise<void> {
  try {
    await db.insert(agentPredictions).values({
      id: crypto.randomUUID(),
      agentName: input.agentName,
      symbol: input.symbol,
      prediction: input.side,
      confidence: input.confidence,
      reasoning: input.reasoning,
      timestamp: input.timestamp || new Date().toISOString(),
      traceId: input.traceId ?? null,
      regime: input.regime ?? null,
    });
  } catch (e) {
    console.error('[ModelPerformanceTracker] Failed to record prediction', e);
  }
}

export interface RegimeBucketStats {
  regime: string;
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  avgReturn: number;
}

/**
 * Real, read-only join of this agent's agentPredictions rows against their graded
 * predictionOutcomes (same two tables + join key PredictionOutcomeEvaluator/ReflectionEngine
 * already use), grouped by the regime captured at prediction time. Predictions not yet evaluated
 * (no matching outcome row yet - PredictionOutcomeEvaluator grades on its own horizon/cadence) are
 * excluded, never counted as a loss. Rows with no captured regime are grouped under 'UNKNOWN'
 * rather than dropped, so the totals are honestly reconcilable against getModelStatus's overall count.
 */
export async function getRegimeSegmentedStats(agentName: string): Promise<RegimeBucketStats[]> {
  const predictions = await db.select().from(agentPredictions).where(eq(agentPredictions.agentName, agentName));
  if (predictions.length === 0) return [];

  const predictionIds = new Set(predictions.map((p) => p.id));
  const regimeById = new Map(predictions.map((p) => [p.id, p.regime ?? 'UNKNOWN']));

  const outcomes = await db.select().from(predictionOutcomes).where(eq(predictionOutcomes.sourceTable, 'agent_predictions'));

  const buckets = new Map<string, { total: number; wins: number; losses: number; returnSum: number }>();
  for (const o of outcomes) {
    if (!predictionIds.has(o.predictionId)) continue;
    if (o.outcome === 'N_A') continue;
    const regime = regimeById.get(o.predictionId) ?? 'UNKNOWN';
    const bucket = buckets.get(regime) ?? { total: 0, wins: 0, losses: 0, returnSum: 0 };
    bucket.total += 1;
    if (o.outcome === 'WIN') bucket.wins += 1;
    else bucket.losses += 1;
    bucket.returnSum += o.actualReturn ?? 0;
    buckets.set(regime, bucket);
  }

  return [...buckets.entries()].map(([regime, b]) => ({
    regime,
    total: b.total,
    wins: b.wins,
    losses: b.losses,
    winRate: b.total > 0 ? b.wins / b.total : 0,
    avgReturn: b.total > 0 ? b.returnSum / b.total : 0,
  }));
}
