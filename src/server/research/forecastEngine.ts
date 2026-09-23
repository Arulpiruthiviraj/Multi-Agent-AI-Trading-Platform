/**
 * ARGUS MASTER TRANSFORMATION MANDATE Part 7 - the Quant Forecast Engine's TypeScript
 * orchestration layer. Owns exactly what CLAUDE.md's Java 26 Engine Authority assigns to
 * TypeScript (rule 16: "orchestrate, expose APIs, persist read models, display results,
 * coordinate services"): assembling a REAL sample of historical forward returns from Argus's own
 * already-graded prediction-outcome database, calling the authoritative Java statistical
 * computation (ForecastEngine.java via QuantCoreBridge.fetchForecast), and persisting an
 * immutable, versioned forecast record with full provenance. It never computes the actual
 * mean/median/trimmed-mean/Wilson-interval statistics itself - that would duplicate Java's
 * authoritative calculation path (rule 7).
 *
 * Real data audit (2026-09-13, this pass): `prediction_outcome_horizons` (the explicit
 * multi-horizon table, MultiHorizonOutcomeEvaluator.ts) has ZERO rows in production today - it is
 * `IMPLEMENTED_BUT_IDLE`, needing real elapsed time to accumulate (see
 * docs/ARGUS_MASTER_COMPLETION_LEDGER.md Part 13). `prediction_outcomes` (the older,
 * single-horizon-per-row table, PredictionOutcomeEvaluator.ts) has 81,736 real graded rows today -
 * that is the only source with enough real volume to build against right now. This module
 * therefore supports both, honestly:
 *   - horizonLabel 'PRIMARY_EVAL_HORIZON' reads prediction_outcomes (real data exists today).
 *     Per PredictionOutcomeEvaluator.ts's own resolveEvaluationHorizonMs(), this is each agent's
 *     real, config-driven evaluation window (config/evaluationHorizons.json) - not a single fixed
 *     duration across every row - so this label is deliberately descriptive, not a precise
 *     duration claim.
 *   - any other horizonLabel reads prediction_outcome_horizons filtered to that label (real
 *     infrastructure, real INSUFFICIENT_DATA today - never fabricated to look populated).
 *
 * Grouping key: for agentName='QuantEngine', strategyId is resolved via the EXISTING
 * secondaryGroupKey() (reasoning-text regex, predictionIndependencePolicy.ts) - the same
 * real-but-imperfect mechanism agentEdgeAnalytics.ts/opportunitySnapshot.ts already use, NOT yet
 * the agent_predictions.strategy_id column. This session's audit found and fixed the real bug that
 * made strategy_id populate on zero live rows (QuantSignalAgent.ts's resolvedStrategyId), but that
 * fix only affects NEW rows going forward - the 81,736 existing prediction_outcomes rows this
 * module reads today were written before the fix and still have strategy_id=null, so
 * secondaryGroupKey() remains the only way to get real per-strategy volume right now. A future
 * pass should migrate this module (and agentEdgeAnalytics.ts) to prefer strategy_id once enough
 * post-fix volume exists - tracked, not silently left as a permanent choice.
 */
import { db } from '../db';
import { agentPredictions, kronosPredictions, predictionOutcomes, predictionOutcomeHorizons, quantForecasts } from '../db/schema';
import { eq, and, desc, isNull } from 'drizzle-orm';
import { secondaryGroupKey } from './predictionIndependencePolicy';
import { quantCoreBridge, type InstitutionalForecastResult } from '../services/QuantCoreBridge';
import { buildTradeEconomicAttributionReport, summarizeTradeEconomicAttribution } from './tradeEconomicAttribution';
import type { CostQuality } from './canonicalCostModel';
import { tradingSafety } from '../config/tradingSafety';
import { researchSafety } from '../config/researchSafety';

/**
 * Net-Expectancy Plumbing (2026-09-23, Argus World-Class Open-Source Quant Expansion roadmap,
 * Priority #5 - operator-directed, explicitly sequenced after Priority #2's canonical cost model
 * and explicitly SHADOW/observability-only: "do not let ChiefTrader, RiskEngine, PositionSizing,
 * or OMS consume the new fields yet"). Model version bumped from 'forecast-v2-gross-only-2026-09-19'
 * because this is the first version where estimatedTransactionCostBps/netExpectedReturn can ever be
 * real, non-null values - the field NAMES are unchanged (extends the existing contract, per explicit
 * operator instruction, rather than adding a parallel `expectedCost` field with an overlapping
 * meaning), but what previously ALWAYS read UNKNOWN_TOTAL_COST/null can now genuinely read
 * REAL_EXECUTION_QUALITY/a real number once enough measured-cost trade legs exist
 * (tradeEconomicAttribution.ts, Priority #2).
 *
 * Cost source: `tradeEconomicAttribution.ts`'s real per-leg cost breakdown (slippage + honestly-
 * classified commission), NOT `executionQuality.ts`'s slippage-only summary this module used
 * before - the same real evidence, now cost-complete rather than slippage-only. `expectedReturn`
 * itself (from `prediction_outcomes.actualReturn`) is a ONE-WAY forward price return referenced
 * from a prediction's own timestamp to a horizon - not a realized round-trip trade - so the cost
 * netted against it is deliberately the mean cost of ONE trade leg, never doubled to simulate an
 * entry+exit round trip that `expectedReturn` was never measuring in the first place. No BUY-leg-
 * to-SELL-leg cost linkage is invented anywhere in this module (that limitation is documented, not
 * worked around, in `tradeEconomicAttribution.ts`'s own header).
 */
export const FORECAST_MODEL_VERSION = 'forecast-v3-net-expectancy-2026-09-23';
export const PRIMARY_EVAL_HORIZON_LABEL = 'PRIMARY_EVAL_HORIZON';

export type ForecastStatus =
  | 'VALID' | 'INSUFFICIENT_DATA' | 'MODEL_UNAVAILABLE' | 'UNSUPPORTED_HORIZON';

/**
 * Real, already-computed strategy-diversity evidence from the SAME canonical source ChiefTrader's
 * own independent-qualification bar uses - internalQuantEnsemble.ts's
 * computeInternalEnsembleQualification(), which combines real TS strategy evaluations with the
 * Java-research-engine votes for THIS cycle and runs them through QuantEnsembleEngine.java's
 * correlation-adjusted math (never a naive vote count). This module has no live market bars or
 * strategy-evaluation context of its own and MUST NOT attempt to recompute or approximate this -
 * it only ever persists what a caller who genuinely has this cycle's real ensemble result supplies.
 * Absent (undefined/null) is the correct, honest state for any forecast built without one (e.g. an
 * ad hoc `argus-cli forecast` call with no live evaluation context) - never fabricated.
 */
export interface EnsembleEvidence {
  /** Real count of votes that actually contributed this cycle (InternalEnsembleQualification.totalVotes)
   *  - never a count of emitted predictions or duplicate parameter variants. */
  strategyCount: number;
  /** Real distinct-family count on the ensemble's own resolved side (never strategyCount relabeled). */
  familyCount: number;
  /** Real correlation-adjusted effective independent count (QuantEnsembleEngine.java) - only equal
   *  to strategyCount when the underlying votes are genuinely uncorrelated; never assumed equal. */
  effectiveIndependentCount: number;
}

export interface ForecastRequest {
  agentName: string;
  /** Real QuantEngine strategy id if this forecast should be strategy-specific; null/omitted for
   *  an agent-level (cross-strategy) forecast. */
  strategyId?: string | null;
  symbol: string;
  direction: 'BUY' | 'SELL';
  /** Defaults to PRIMARY_EVAL_HORIZON_LABEL - see this module's own header for what that means. */
  horizonLabel?: string;
  regime?: string | null;
  /** See EnsembleEvidence's own doc comment - omit/null when the caller has no real ensemble
   *  result for this cycle; never fabricated by this module. */
  ensembleEvidence?: EnsembleEvidence | null;
}

/** The canonical Forecast contract (Master Transformation Mandate Part 7 item 2). Every numeric
 *  field is null, not a fabricated default, when forecastStatus !== 'VALID'. */
export interface Forecast {
  forecastId: string;
  symbol: string;
  timestamp: string;
  direction: 'BUY' | 'SELL';
  horizon: string;
  agentName: string;
  strategyId: string | null;
  regime: string | null;
  status: ForecastStatus;
  sampleSize: number;
  expectedReturn: number | null;
  expectedReturnLower: number | null;
  expectedReturnUpper: number | null;
  medianReturn: number | null;
  trimmedMeanReturn: number | null;
  probabilityOfProfit: number | null;
  probabilityOfProfitLower: number | null;
  probabilityOfProfitUpper: number | null;
  /** Symbol-level market volatility - always null in this pass (no bar series is supplied by any
   *  current caller); a real, tracked follow-up, never a fabricated placeholder. */
  volatility: number | null;
  /** Dispersion of the historical-return sample itself (mandate item 7's "uncertainty around
   *  expected return", deliberately distinct from expectedReturn). */
  uncertainty: number | null;
  /** The real, measured mean per-leg cost (slippage + honestly-classified commission, in bps) this
   *  forecast's net figure was netted against - null whenever costQuality is not MEASURED. This IS
   *  the "expectedCost" concept from the roadmap's Priority #5 spec, expressed in the units this
   *  field has always been named for (extends the existing contract rather than adding a second,
   *  overlapping `expectedCost` field). */
  estimatedTransactionCostBps: number | null;
  /** expectedReturn minus estimatedTransactionCostBps (converted to the same fractional-return
   *  scale) - null whenever either side is unavailable. Never computed from an ESTIMATED/PARTIAL
   *  cost figure presented as if it were real; only ever populated when costQuality is MEASURED. */
  netExpectedReturn: number | null;
  /** Real cost-quality label (canonicalCostModel.ts) for estimatedTransactionCostBps/netExpectedReturn.
   *  UNAVAILABLE (not a fabricated ESTIMATED) whenever fewer than researchSafety.minOosTrades real
   *  measured-cost trade legs exist yet. */
  costQuality: CostQuality;
  /** True iff netExpectedReturn is a real, non-null number - a single, explicit boolean gate so a
   *  future consumer never has to infer "is net return real" from a null-check on a nested field. */
  netReturnAvailable: boolean;
  /** Real strategy-diversity evidence from EnsembleEvidence (internalQuantEnsemble.ts) when the
   *  caller supplied one for this cycle; null when it did not - never independently computed or
   *  approximated by this module (see EnsembleEvidence's own doc comment for why). */
  strategyCount: number | null;
  familyCount: number | null;
  effectiveIndependentCount: number | null;
  modelVersion: string;
  featureSnapshotId: null;
  strategySnapshotId: null;
  provenance: {
    sourceTable: 'prediction_outcomes' | 'prediction_outcome_horizons';
    groupingKey: string;
    /** Real, uncapped count of matching historical-outcome rows found - may exceed
     *  sampleSizeSentToModel when forecastEngineMaxSampleSize bounds the actual Java payload. */
    sourceRowCount: number;
    /** The real, most-recent-first-capped count actually sent to ForecastEngine.java. */
    sampleSizeSentToModel: number;
    transactionCostSource: 'REAL_EXECUTION_QUALITY' | 'NONE_ASSUMED_ZERO' | 'UNKNOWN_TOTAL_COST';
    measuredSlippageBps?: number | null;
    executionEvidenceClass?: 'PAPER_ORGANIC';
    readCostStatus?: 'UNKNOWN_TOTAL_COST';
    /** Real count of MEASURED-cost trade legs estimatedTransactionCostBps was computed from - the
     *  roadmap's own "costProvenance" concept, folded into this existing provenance bag rather than
     *  a new parallel top-level field (see this file's own header comment for the reasoning). */
    costSampleSize: number;
  };
}

interface OrientedReturn { value: number; timestamp: string }

/** Caps and orders a real historical sample to the most recent N observations before it is ever
 *  sent to Java. Real bug found and fixed this pass (Master Transformation Mandate Part 7,
 *  "Java Bridge Reliability"): an unbounded query against a real, large agent (57,504 real
 *  TechnicalAgent BUY outcomes) serialized its ENTIRE history into one HTTP POST body, blowing
 *  through quantJavaCoreRequestTimeoutMs (100ms - measured failure at 108ms via a real live CLI
 *  run) every time. Capping to the most recent forecastEngineMaxSampleSize observations is not
 *  just a performance fix - it is also the statistically correct choice (mandate item 4's "avoid
 *  overfitting" / prefer recent, representative evidence over an unbounded stale-inclusive blend).
 */
function capToMostRecent(rows: OrientedReturn[]): number[] {
  return rows
    .slice()
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, tradingSafety.forecastEngineMaxSampleSize)
    .map((r) => r.value);
}

async function collectPrimaryHorizonReturns(agentName: string, strategyId: string | null, direction: 'BUY' | 'SELL'): Promise<OrientedReturn[]> {
  const predRows = await db.select().from(agentPredictions).where(eq(agentPredictions.agentName, agentName)).all();
  const predById = new Map(predRows.map((p) => [p.id, p]));
  const outcomeRows = await db.select().from(predictionOutcomes).where(eq(predictionOutcomes.sourceTable, 'agent_predictions')).all();

  const out: OrientedReturn[] = [];
  for (const o of outcomeRows) {
    if (o.actualReturn === null || o.actualReturn === undefined) continue;
    const p = predById.get(o.predictionId);
    if (!p || p.prediction !== direction) continue;
    if (strategyId) {
      const rawKey = secondaryGroupKey(agentName, p.reasoning);
      const resolved = rawKey ? rawKey.replace(/__COLD_START_BOOTSTRAP$/, '') : null;
      if (resolved !== strategyId) continue;
    }
    const oriented = direction === 'BUY' ? o.actualReturn : -o.actualReturn;
    out.push({ value: oriented, timestamp: p.timestamp });
  }
  return out;
}

async function collectExplicitHorizonReturns(agentName: string, strategyId: string | null, direction: 'BUY' | 'SELL', horizonLabel: string): Promise<OrientedReturn[]> {
  const horizonRows = await db.select().from(predictionOutcomeHorizons)
    .where(and(eq(predictionOutcomeHorizons.sourceTable, 'agent_predictions'), eq(predictionOutcomeHorizons.horizonLabel, horizonLabel)))
    .all();
  if (horizonRows.length === 0) return [];

  const predRows = await db.select().from(agentPredictions).where(eq(agentPredictions.agentName, agentName)).all();
  const predById = new Map(predRows.map((p) => [p.id, p]));

  const out: OrientedReturn[] = [];
  for (const h of horizonRows) {
    if (h.forwardReturn === null || h.forwardReturn === undefined) continue;
    const p = predById.get(h.predictionId);
    if (!p || p.prediction !== direction) continue;
    if (strategyId) {
      const rawKey = secondaryGroupKey(agentName, p.reasoning);
      const resolved = rawKey ? rawKey.replace(/__COLD_START_BOOTSTRAP$/, '') : null;
      if (resolved !== strategyId) continue;
    }
    const oriented = direction === 'BUY' ? h.forwardReturn : -h.forwardReturn;
    out.push({ value: oriented, timestamp: p.timestamp });
  }
  return out;
}

interface ExpectedCostResolution {
  bps: number | null;
  source: 'REAL_EXECUTION_QUALITY' | 'UNKNOWN_TOTAL_COST';
  costQuality: CostQuality;
  measuredSlippageBps: number | null;
  costSampleSize: number;
}

/**
 * Net-Expectancy Plumbing (roadmap Priority #5). Reuses tradeEconomicAttribution.ts's real
 * per-leg cost breakdown (Priority #2) - slippage AND honestly-classified commission, not just
 * slippage as this function's predecessor did. Only reports a real, usable bps figure
 * (costQuality: 'MEASURED') once at least researchSafety.minOosTrades real MEASURED-cost trade
 * legs exist - the same reviewed "trustworthy sample" floor already used elsewhere in this
 * research module family (agentDependenceAnalysis.ts), not a newly-invented number. Below that
 * floor, or with zero measured-cost evidence at all, this returns UNAVAILABLE/null - never an
 * ESTIMATED guess dressed up as real.
 *
 * Operator review note (2026-09-23): reusing minOosTrades here conceptually couples two distinct
 * ideas - minimum OOS *trade* evidence (what that constant was originally reviewed for) and minimum
 * *cost-estimation* sample evidence (what it gates here). Deliberate reuse, not an oversight - there
 * isn't yet enough real data volume to justify calibrating a separate threshold. Flagged as a real,
 * named candidate for its own reviewed `researchSafety.json` constant (e.g. `minCostEstimationTrades`)
 * once enough real PAPER_ORGANIC cost evidence exists to inform that choice with actual data rather
 * than another guess.
 */
async function resolveExpectedCost(): Promise<ExpectedCostResolution> {
  try {
    const rows = await buildTradeEconomicAttributionReport(500, 'PAPER_ORGANIC');
    const summary = summarizeTradeEconomicAttribution(rows, 'PAPER_ORGANIC');
    const measuredSlippageBps = rows.length > 0
      ? rows.reduce((s, r) => s + r.cost.slippageBps, 0) / rows.length
      : null;
    if (summary.meanTotalCostBps !== null && summary.costMeasuredN >= researchSafety.minOosTrades) {
      return {
        bps: summary.meanTotalCostBps,
        source: 'REAL_EXECUTION_QUALITY',
        costQuality: 'MEASURED',
        measuredSlippageBps,
        costSampleSize: summary.costMeasuredN,
      };
    }
    return { bps: null, source: 'UNKNOWN_TOTAL_COST', costQuality: 'UNAVAILABLE', measuredSlippageBps, costSampleSize: summary.costMeasuredN };
  } catch {
    /* unavailable evidence remains unknown */
  }
  return { bps: null, source: 'UNKNOWN_TOTAL_COST', costQuality: 'UNAVAILABLE', measuredSlippageBps: null, costSampleSize: 0 };
}

/**
 * Forensic audit fix (2026-09-14, docs/ARGUS_FULL_DEFECT_AUDIT.md): QuantSignalAgent.ts's
 * fire-and-forget buildForecast() call has no cooldown of its own - if the same symbol qualifies
 * for a real emitted idea in two back-to-back evaluation cycles before the first forecast build
 * finishes (a real possibility; a Java call plus several DB reads can take up to the ~100ms bridge
 * timeout, well within this pipeline's own real evaluation cadence), two fully independent builds
 * would run concurrently for the identical (agent, strategy, symbol, direction, horizon) key -
 * duplicate DB reads, a duplicate Java call, and two near-simultaneous quant_forecasts rows. Not a
 * correctness bug (both rows would be real and valid; quant_forecasts intentionally allows many
 * rows over time) but genuine wasted work and unnecessary Java-bridge load - exactly the risk
 * class already found once tonight (the unbounded-payload timeout). In-flight request coalescing
 * (a standard, safe pattern) makes the second concurrent call for the same key simply await the
 * first's result instead of starting a redundant build - correct for fire-and-forget telemetry,
 * never used for anything decision-critical.
 */
const inFlightForecastBuilds = new Map<string, Promise<Forecast>>();

function forecastRequestKey(req: ForecastRequest): string {
  return `${req.agentName}|${req.strategyId ?? ''}|${req.symbol}|${req.direction}|${req.horizonLabel ?? PRIMARY_EVAL_HORIZON_LABEL}`;
}

export async function buildForecast(req: ForecastRequest): Promise<Forecast> {
  const key = forecastRequestKey(req);
  const existing = inFlightForecastBuilds.get(key);
  if (existing) return existing;
  const promise = buildForecastUncoalesced(req).finally(() => {
    inFlightForecastBuilds.delete(key);
  });
  inFlightForecastBuilds.set(key, promise);
  return promise;
}

/**
 * Builds and persists one immutable forecast row. Never overwrites a prior forecast for the same
 * (symbol, agent, strategy, direction, horizon) - each call is a new row with its own
 * forecastId/timestamp, per the mandate's own "do not overwrite historical forecasts" rule.
 */
async function buildForecastUncoalesced(req: ForecastRequest): Promise<Forecast> {
  const horizon = req.horizonLabel ?? PRIMARY_EVAL_HORIZON_LABEL;
  const isPrimary = horizon === PRIMARY_EVAL_HORIZON_LABEL;

  const returns = isPrimary
    ? await collectPrimaryHorizonReturns(req.agentName, req.strategyId ?? null, req.direction)
    : await collectExplicitHorizonReturns(req.agentName, req.strategyId ?? null, req.direction, horizon);

  const { bps: transactionCostBps, source: transactionCostSource, costQuality, measuredSlippageBps, costSampleSize } = await resolveExpectedCost();

  const groupingKey = req.strategyId ? `${req.agentName}/${req.strategyId}` : req.agentName;
  const forecastId = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  // Real evidence found may vastly exceed what a single ~100ms Java bridge call can carry -
  // capToMostRecent() bounds the actual HTTP payload; sourceRowCount below still reports the true,
  // uncapped real evidence count, so provenance never understates how much history actually exists.
  const cappedReturns = capToMostRecent(returns);

  const javaResult: InstitutionalForecastResult | null = await quantCoreBridge.fetchForecast(
    req.symbol,
    cappedReturns,
    0, // Gross-return statistics only; cost-derived Java outputs are not used without total costs.
  );

  const provenance = {
    sourceTable: (isPrimary ? 'prediction_outcomes' : 'prediction_outcome_horizons') as 'prediction_outcomes' | 'prediction_outcome_horizons',
    groupingKey,
    sourceRowCount: returns.length,
    sampleSizeSentToModel: cappedReturns.length,
    transactionCostSource,
    measuredSlippageBps,
    executionEvidenceClass: 'PAPER_ORGANIC' as const,
    costSampleSize,
  };

  // Real strategy-diversity evidence, when the caller genuinely has one for this cycle - never
  // computed here (see EnsembleEvidence's own doc comment). Persisted regardless of whether the
  // Java forecast math itself succeeds, since strategy diversity is a separate real measurement.
  const ev = req.ensembleEvidence ?? null;
  const strategyCount = ev?.strategyCount ?? null;
  const familyCount = ev?.familyCount ?? null;
  const effectiveIndependentCount = ev?.effectiveIndependentCount ?? null;

  let forecast: Forecast;
  if (!javaResult) {
    // Java unreachable/disabled/circuit-open - fail-closed, never fabricate a forecast. Distinct
    // from INSUFFICIENT_DATA (which means the Java call succeeded but the real sample was thin).
    forecast = {
      forecastId, symbol: req.symbol, timestamp, direction: req.direction, horizon,
      agentName: req.agentName, strategyId: req.strategyId ?? null, regime: req.regime ?? null,
      status: 'MODEL_UNAVAILABLE', sampleSize: returns.length,
      expectedReturn: null, expectedReturnLower: null, expectedReturnUpper: null,
      medianReturn: null, trimmedMeanReturn: null,
      probabilityOfProfit: null, probabilityOfProfitLower: null, probabilityOfProfitUpper: null,
      volatility: null, uncertainty: null,
      estimatedTransactionCostBps: transactionCostBps, netExpectedReturn: null,
      costQuality, netReturnAvailable: false,
      strategyCount, familyCount, effectiveIndependentCount,
      modelVersion: FORECAST_MODEL_VERSION, featureSnapshotId: null, strategySnapshotId: null,
      provenance,
    };
  } else {
    const status: ForecastStatus = javaResult.status === 'VALID' ? 'VALID' : 'INSUFFICIENT_DATA';
    // Net-Expectancy Plumbing (roadmap Priority #5): only ever computed when BOTH a real gross
    // expectedReturn (status VALID) AND a real MEASURED cost figure exist - never nets an
    // ESTIMATED/PARTIAL/UNAVAILABLE cost against a real return and presents the result as if it
    // were trustworthy. expectedReturn is a fractional return (e.g. 0.01 = 1%); bps/10000 converts
    // the cost onto the same scale before subtracting.
    const netExpectedReturn = (status === 'VALID' && javaResult.meanReturn !== null && costQuality === 'MEASURED' && transactionCostBps !== null)
      ? javaResult.meanReturn - (transactionCostBps / 10000)
      : null;
    forecast = {
      forecastId, symbol: req.symbol, timestamp, direction: req.direction, horizon,
      agentName: req.agentName, strategyId: req.strategyId ?? null, regime: req.regime ?? null,
      status, sampleSize: javaResult.sampleSize,
      expectedReturn: javaResult.meanReturn, expectedReturnLower: javaResult.meanReturnLower, expectedReturnUpper: javaResult.meanReturnUpper,
      medianReturn: javaResult.medianReturn, trimmedMeanReturn: javaResult.trimmedMeanReturn,
      probabilityOfProfit: null, probabilityOfProfitLower: null, probabilityOfProfitUpper: null,
      volatility: null, uncertainty: javaResult.stdevReturn,
      estimatedTransactionCostBps: transactionCostBps, netExpectedReturn,
      costQuality, netReturnAvailable: netExpectedReturn !== null,
      strategyCount, familyCount, effectiveIndependentCount,
      modelVersion: FORECAST_MODEL_VERSION, featureSnapshotId: null, strategySnapshotId: null,
      provenance,
    };
  }

  try {
    await db.insert(quantForecasts).values({
      forecastId: forecast.forecastId,
      symbol: forecast.symbol,
      createdAt: forecast.timestamp,
      direction: forecast.direction,
      horizonLabel: forecast.horizon,
      agentName: forecast.agentName,
      strategyId: forecast.strategyId,
      regime: forecast.regime,
      forecastStatus: forecast.status,
      sampleSize: forecast.sampleSize,
      expectedReturn: forecast.expectedReturn,
      expectedReturnLower: forecast.expectedReturnLower,
      expectedReturnUpper: forecast.expectedReturnUpper,
      medianReturn: forecast.medianReturn,
      trimmedMeanReturn: forecast.trimmedMeanReturn,
      probabilityOfProfit: forecast.probabilityOfProfit,
      probabilityOfProfitLower: forecast.probabilityOfProfitLower,
      probabilityOfProfitUpper: forecast.probabilityOfProfitUpper,
      volatility: forecast.volatility,
      uncertaintyStdevReturn: forecast.uncertainty,
      estimatedTransactionCostBps: forecast.estimatedTransactionCostBps,
      netExpectedReturn: forecast.netExpectedReturn,
      costQuality: forecast.costQuality,
      costSampleSize: forecast.provenance.costSampleSize,
      strategyCount: forecast.strategyCount,
      familyCount: forecast.familyCount,
      effectiveIndependentCount: forecast.effectiveIndependentCount,
      modelVersion: forecast.modelVersion,
      provenanceJson: JSON.stringify(forecast.provenance),
    });
  } catch (e) {
    console.error('[forecastEngine] Failed to persist forecast', e);
  }

  return forecast;
}

/** Real, already-persisted forecasts for a symbol (read-only, no live Java call) - the safe,
 *  bounded way for other read models (e.g. opportunitySnapshot.ts) to reference a forecast
 *  without adding a live network call to their own hot path (mandate item 24). */
export async function mostRecentForecast(symbol: string, agentName: string, strategyId: string | null, direction: 'BUY' | 'SELL', horizonLabel = PRIMARY_EVAL_HORIZON_LABEL): Promise<Forecast | null> {
  // Forensic audit fix (2026-09-14, docs/ARGUS_FULL_DEFECT_AUDIT.md, FD-3): strategyId used to be
  // filtered in JS AFTER fetching only the 50 most recent rows for the broader
  // (symbol, agentName, direction, horizonLabel) key - a real false-negative once enough OTHER
  // strategies (or the agent-level null-strategy case) had built more recent forecasts under the
  // same key than this one, `.find()` would return undefined and this function would incorrectly
  // report "no forecast" even though a real, valid, more-recent-for-THIS-strategy row exists just
  // outside that window. Filtering strategyId in SQL makes the database return the genuinely most
  // recent row for the exact requested key - correct regardless of how many other strategies are
  // also emitting forecasts under the same broader key.
  const rows = await db.select().from(quantForecasts)
    .where(and(
      eq(quantForecasts.symbol, symbol),
      eq(quantForecasts.agentName, agentName),
      eq(quantForecasts.direction, direction),
      eq(quantForecasts.horizonLabel, horizonLabel),
      strategyId ? eq(quantForecasts.strategyId, strategyId) : isNull(quantForecasts.strategyId),
    ))
    .orderBy(desc(quantForecasts.createdAt))
    .limit(1)
    .all();
  const row = rows[0];
  if (!row) return null;
  return {
    forecastId: row.forecastId, symbol: row.symbol, timestamp: row.createdAt,
    direction: row.direction as 'BUY' | 'SELL', horizon: row.horizonLabel,
    agentName: row.agentName, strategyId: row.strategyId, regime: row.regime,
    status: row.forecastStatus as ForecastStatus, sampleSize: row.sampleSize,
    expectedReturn: row.expectedReturn, expectedReturnLower: row.expectedReturnLower, expectedReturnUpper: row.expectedReturnUpper,
    medianReturn: row.medianReturn, trimmedMeanReturn: row.trimmedMeanReturn,
    probabilityOfProfit: null, probabilityOfProfitLower: null, probabilityOfProfitUpper: null,
    volatility: row.volatility, uncertainty: row.uncertaintyStdevReturn,
    // Net-Expectancy Plumbing (roadmap Priority #5) fix: this read path previously forced these
    // two fields to null unconditionally - harmless before this pass (every persisted row genuinely
    // had them null anyway), but a real bug once buildForecast() can persist real, non-null values -
    // reading them back as null would silently destroy correctly-computed net-expectancy evidence
    // on every read. Now returns exactly what was persisted.
    estimatedTransactionCostBps: row.estimatedTransactionCostBps, netExpectedReturn: row.netExpectedReturn,
    // Legacy rows written before migration 0073 have no real costQuality column value - UNAVAILABLE
    // is the honest default (matches what resolveExpectedCost() would have returned then), never MEASURED.
    costQuality: (row.costQuality as CostQuality | null) ?? 'UNAVAILABLE',
    netReturnAvailable: row.netExpectedReturn !== null,
    strategyCount: row.strategyCount, familyCount: row.familyCount, effectiveIndependentCount: row.effectiveIndependentCount,
    modelVersion: row.modelVersion, featureSnapshotId: null, strategySnapshotId: null,
    provenance: { ...JSON.parse(row.provenanceJson), costSampleSize: row.costSampleSize ?? 0 },
  };
}
