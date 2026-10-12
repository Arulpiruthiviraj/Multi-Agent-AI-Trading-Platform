/**
 * Phase 7D/7E (Calibration statistical validation, 2026-08-27). Recomputes each currently-active
 * agent_confidence_calibration (agent, bucket) row using EFFECTIVE (autocorrelation-clustered)
 * sample size instead of the raw, uncorrected count ReflectionEngine.ts writes today - closing the
 * exact gap the Phase 6C/7C forensic audits found (QuantEngine's 0.8-0.9 bucket: 562 raw rows,
 * ~86 estimated independent clusters).
 *
 * Governance, explicit: this module is ADDITIVE and OBSERVATIONAL ONLY in this pass. It:
 *   - never writes to agent_confidence_calibration (ReflectionEngine.ts's raw write path is
 *     completely untouched and remains the ONLY thing ChiefTraderAgent.calibrateConfidence()
 *     actually reads from today);
 *   - only writes to learning_versions/promotion_decisions/rollback_events (Phase 4H's existing,
 *     generic, already-tested champion/challenger ledger - versionType `calibration:<agent>:<low>-
 *     <high>`), which nothing in the live consensus path reads;
 *   - never imports ChiefTraderAgent, RiskEngine, OMS, or BrokerManager, and never emits
 *     TRADE_IDEA_GENERATED or any consensus-affecting event.
 * Wiring the gated/promoted value into calibrateConfidence() itself is a distinct, separate,
 * explicitly-deferred decision - see the module-level note in ChiefTraderAgent.ts's own
 * calibrateConfidence() (not modified this pass) and the final Phase 7 report's own callout.
 *
 * Promotion semantics deliberately differ from Phase 4H's original "challenger must beat champion"
 * framing: a recalibration is not competing to be numerically "better" than the last one, it is a
 * refreshed estimate of the same real-world accuracy as more independent evidence accumulates. So
 * `championMetricValue` is always passed as null here - the only real gate is the EFFECTIVE sample
 * size floor (never merely raw count), matching the mission's explicit "not merely raw sample
 * size" requirement. This is a deliberate, documented simplification, not an oversight.
 */
import { db } from '../db';
import { agentPredictions, predictionOutcomes, kronosPredictions, agentConfidenceCalibration } from '../db/schema';
import { eq, and, gt, sql } from 'drizzle-orm';
import { CONFIDENCE_BUCKETS, type ConfidenceBucket, calibratedConfidenceForBucket, bucketMidpoint } from '../services/ConfidenceCalibration';
import { rawVsEffectiveDirectional, type ClusterableRow } from '../research/effectiveSampleSize';
import { independenceClusterGapMs, secondaryGroupKey } from '../research/predictionIndependencePolicy';
import { TELEMETRY_PULSE_TRACE_PREFIX } from '../core/telemetryPulse';
import { continuousIntelligence } from '../config/continuousIntelligence';
import { tradingSafety } from '../config/tradingSafety';
import * as ChampionChallenger from './ChampionChallengerService';
import { logErrorSafely } from '../core/SecretRedaction';

export function calibrationVersionType(agentName: string, bucket: ConfidenceBucket): string {
  return `calibration:${agentName}:${bucket.low}-${bucket.high}`;
}

export type { RawRow };

export interface CalibrationCandidate {
  agentName: string;
  bucketLow: number;
  bucketHigh: number;
  rawN: number;
  rawWins: number;
  rawWinRate: number | null;
  effectiveN: number;
  effectiveWins: number;
  effectiveWinRate: number | null;
  wilsonLower: number | null;
  wilsonUpper: number | null;
  inflationFactor: number | null;
  candidateCalibratedConfidence: number;
  currentActiveCalibratedConfidence: number | null;
  oldestObservationAt: string | null;
  newestObservationAt: string | null;
  isStale: boolean;
  regimeBreakdown: Record<string, { n: number; wins: number }>;
  symbolConcentration: Array<{ symbol: string; count: number; sharePct: number }>;
}

interface RawRow {
  symbol: string;
  side: string;
  timestampMs: number;
  outcome: 'WIN' | 'LOSS' | 'N_A';
  reasoning: string | null;
  regime: string | null;
}

/** Exported for calibrationDriftReport.ts (Phase 6) - re-fetches the same raw rows this module
 * already builds calibration candidates from, so the drift report never duplicates this query. */
/** Yields a real macrotask turn so timers, sockets and health checks can run between SQLite calls. */
const yieldToEventLoop = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

interface RawRowWithConfidence extends RawRow {
  confidence: number;
}

/**
 * 2026-10-12 (event-loop stall fix): ALL of one agent's evaluated predictions, loaded ONCE and in small
 * pages (calibrationFetchPageRows), yielding to the event loop between pages. Previously the SQL filtered
 * only by agent and this ran once per (agent, bucket) row - 38 full re-loads per 15-minute cycle, as one
 * uninterrupted synchronous task (~3.5-4 min live, with /health dead and PortfolioMonitor reviews missed).
 * Ordering is rowid-ascending (insertion order), which preserves the row order downstream tie-handling saw.
 * The telemetry-pulse exclusion is unchanged.
 */
async function loadAgentRowsAll(agentName: string): Promise<RawRowWithConfidence[]> {
  const pageRows = tradingSafety.calibrationFetchPageRows;
  const out: RawRowWithConfidence[] = [];
  let lastRowid = 0;
  for (;;) {
    const rows = await db.select({
      rowid: sql<number>`"agent_predictions"."rowid"`,
      symbol: agentPredictions.symbol,
      side: agentPredictions.prediction,
      timestamp: agentPredictions.timestamp,
      traceId: agentPredictions.traceId,
      reasoning: agentPredictions.reasoning,
      regime: agentPredictions.regime,
      confidence: agentPredictions.confidence,
      outcome: predictionOutcomes.outcome,
    })
      .from(agentPredictions)
      .innerJoin(predictionOutcomes, and(
        eq(predictionOutcomes.predictionId, agentPredictions.id),
        eq(predictionOutcomes.sourceTable, 'agent_predictions'),
      ))
      .where(and(eq(agentPredictions.agentName, agentName), sql`"agent_predictions"."rowid" > ${lastRowid}`))
      .orderBy(sql`"agent_predictions"."rowid"`)
      .limit(pageRows);
    if (rows.length === 0) break;
    for (const r of rows) {
      if (r.traceId && r.traceId.startsWith(TELEMETRY_PULSE_TRACE_PREFIX)) continue;
      out.push({
        symbol: r.symbol,
        side: r.side,
        timestampMs: new Date(r.timestamp).getTime(),
        outcome: r.outcome as 'WIN' | 'LOSS' | 'N_A',
        reasoning: r.reasoning,
        regime: r.regime,
        confidence: r.confidence,
      });
    }
    lastRowid = Number(rows[rows.length - 1].rowid);
    if (rows.length < pageRows) break;
    await yieldToEventLoop();
  }
  return out;
}

function inBucket<T extends { confidence: number }>(rows: T[], bucket: ConfidenceBucket): T[] {
  return rows.filter((r) => r.confidence >= bucket.low && (r.confidence < bucket.high || bucket.high >= 1));
}

function stripConfidence(rows: RawRowWithConfidence[]): RawRow[] {
  return rows.map(({ confidence: _confidence, ...rest }) => rest);
}

export async function fetchAgentPredictionRows(agentName: string, bucket: ConfidenceBucket): Promise<RawRow[]> {
  return stripConfidence(inBucket(await loadAgentRowsAll(agentName), bucket));
}

/**
 * kronos_predictions.id is an integer PK, but prediction_outcomes.predictionId is text - the same
 * type mismatch ReflectionEngine.ts's own evaluateAgents() already works around by joining in JS
 * via a String(id) map rather than a SQL join. Mirrored here rather than introduced fresh.
 */
/** Exported for calibrationDriftReport.ts (Phase 6) - see fetchAgentPredictionRows above. */
/**
 * 2026-10-12: Kronos rows that HAVE an outcome, loaded once and paged (narrow columns only - the table also
 * holds wide predicted_ohlc/JSON columns that the old `select *` dragged into memory 4x per cycle; live: 229k
 * predictions but only ~8k outcomes). Same join semantics as before: a prediction without an outcome is skipped.
 */
async function loadKronosRowsAll(): Promise<RawRowWithConfidence[]> {
  const pageRows = tradingSafety.calibrationFetchPageRows;
  const outcomeById = new Map<string, string>();
  let lastOutcomeId = 0;
  for (;;) {
    const page = await db.select({ id: predictionOutcomes.id, predictionId: predictionOutcomes.predictionId, outcome: predictionOutcomes.outcome })
      .from(predictionOutcomes)
      .where(and(eq(predictionOutcomes.sourceTable, 'kronos_predictions'), gt(predictionOutcomes.id, lastOutcomeId)))
      .orderBy(predictionOutcomes.id)
      .limit(pageRows);
    if (page.length === 0) break;
    for (const o of page) outcomeById.set(o.predictionId, o.outcome);
    lastOutcomeId = page[page.length - 1].id;
    if (page.length < pageRows) break;
    await yieldToEventLoop();
  }
  if (outcomeById.size === 0) return [];

  const out: RawRowWithConfidence[] = [];
  let lastId = 0;
  for (;;) {
    const page = await db.select({
      id: kronosPredictions.id,
      symbol: kronosPredictions.symbol,
      prediction: kronosPredictions.prediction,
      confidence: kronosPredictions.confidence,
      timestamp: kronosPredictions.timestamp,
    })
      .from(kronosPredictions)
      .where(gt(kronosPredictions.id, lastId))
      .orderBy(kronosPredictions.id)
      .limit(pageRows);
    if (page.length === 0) break;
    for (const k of page) {
      const o = outcomeById.get(String(k.id));
      if (!o) continue;
      out.push({
        symbol: k.symbol,
        side: k.prediction,
        timestampMs: new Date(k.timestamp).getTime(),
        outcome: o as 'WIN' | 'LOSS' | 'N_A',
        reasoning: null,
        regime: null,
        confidence: k.confidence,
      });
    }
    lastId = page[page.length - 1].id;
    if (page.length < pageRows) break;
    await yieldToEventLoop();
  }
  return out;
}

/** Exported for calibrationDriftReport.ts (Phase 6) - see fetchAgentPredictionRows above. */
export async function fetchKronosRows(bucket: ConfidenceBucket): Promise<RawRow[]> {
  return stripConfidence(inBucket(await loadKronosRowsAll(), bucket));
}

/** Exported for calibrationDriftReport.ts (Phase 6) - see fetchAgentPredictionRows above. */
export function toClusterableRows(agentName: string, rows: RawRow[]): ClusterableRow[] {
  return rows.map((r) => ({
    symbol: r.symbol,
    agent: agentName,
    side: r.side,
    timestampMs: r.timestampMs,
    outcome: r.outcome,
    secondaryKey: secondaryGroupKey(agentName, r.reasoning) ?? undefined,
  }));
}

function computeRegimeBreakdown(rows: RawRow[]): Record<string, { n: number; wins: number }> {
  const out: Record<string, { n: number; wins: number }> = {};
  for (const r of rows) {
    if (r.outcome === 'N_A') continue;
    const key = r.regime ?? 'UNLABELED';
    if (!out[key]) out[key] = { n: 0, wins: 0 };
    out[key].n += 1;
    if (r.outcome === 'WIN') out[key].wins += 1;
  }
  return out;
}

function computeSymbolConcentration(rows: RawRow[]): Array<{ symbol: string; count: number; sharePct: number }> {
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.symbol] = (counts[r.symbol] ?? 0) + 1;
  const total = rows.length || 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([symbol, count]) => ({ symbol, count, sharePct: (count / total) * 100 }));
}

/**
 * Recomputes every currently-tracked (agent, bucket) pair from real prediction_outcomes data,
 * using effective (clustered) sample size. Never invents a bucket not already present in the live
 * agent_confidence_calibration table - this validates existing calibration, it does not expand it.
 */
export async function buildCalibrationCandidates(now: Date = new Date()): Promise<CalibrationCandidate[]> {
  const active = await db.select().from(agentConfidenceCalibration);

  // 2026-10-12 (event-loop stall fix): group the active rows by agent so each agent's history is loaded ONCE
  // per cycle (it used to be re-loaded per bucket), process that agent's buckets, then release it before the
  // next agent. Candidates are still returned in the original active-row order.
  const rowsByAgent = new Map<string, number[]>();
  active.forEach((row, index) => {
    const list = rowsByAgent.get(row.agentName) ?? [];
    list.push(index);
    rowsByAgent.set(row.agentName, list);
  });
  const slots: Array<CalibrationCandidate | undefined> = new Array(active.length);

  for (const [agentName, indexes] of rowsByAgent) {
    let agentRows: RawRowWithConfidence[];
    try {
      agentRows = agentName === 'KronosEngine' ? await loadKronosRowsAll() : await loadAgentRowsAll(agentName);
    } catch (e) {
      logErrorSafely(`[CalibrationCandidateBuilder] failed to fetch rows for ${agentName}`, e);
      continue;
    }

    for (const index of indexes) {
      const row = active[index];
      const bucket: ConfidenceBucket = { low: row.bucketLow, high: row.bucketHigh };
      const rawRows: RawRow[] = stripConfidence(inBucket(agentRows, bucket));

      const clusterable = toClusterableRows(row.agentName, rawRows);
      const gapMs = independenceClusterGapMs(row.agentName);
      const stats = rawVsEffectiveDirectional(clusterable, gapMs);

      const candidateCalibratedConfidence = calibratedConfidenceForBucket(bucket, stats.effectiveWins, stats.effectiveN - stats.effectiveWins);

      const directional = rawRows.filter((r) => r.outcome !== 'N_A');
      const timestamps = directional.map((r) => r.timestampMs).sort((a, b) => a - b);
      const oldestObservationAt = timestamps.length > 0 ? new Date(timestamps[0]).toISOString() : null;
      const newestObservationAt = timestamps.length > 0 ? new Date(timestamps[timestamps.length - 1]).toISOString() : null;
      const isStale = timestamps.length > 0 && (now.getTime() - timestamps[timestamps.length - 1]) > continuousIntelligence.calibrationMaxObservationAgeMs;

      slots[index] = {
        agentName: row.agentName,
        bucketLow: bucket.low,
        bucketHigh: bucket.high,
        rawN: stats.rawN,
        rawWins: stats.rawWins,
        rawWinRate: stats.rawInterval.pointEstimate,
        effectiveN: stats.effectiveN,
        effectiveWins: stats.effectiveWins,
        effectiveWinRate: stats.effectiveInterval.pointEstimate,
        wilsonLower: stats.effectiveInterval.lower,
        wilsonUpper: stats.effectiveInterval.upper,
        inflationFactor: stats.inflationFactor,
        candidateCalibratedConfidence,
        currentActiveCalibratedConfidence: row.calibratedConfidence,
        oldestObservationAt,
        newestObservationAt,
        isStale,
        regimeBreakdown: computeRegimeBreakdown(rawRows),
        symbolConcentration: computeSymbolConcentration(rawRows),
      };
      // Per-bucket clustering/sorting is CPU work on potentially large arrays; give the loop a turn after each.
      await yieldToEventLoop();
    }
  }

  return slots.filter((c): c is CalibrationCandidate => c !== undefined);
}

export interface CalibrationPromotionResult {
  agentName: string;
  bucketLow: number;
  bucketHigh: number;
  versionId: string;
  decision: 'PASS' | 'FAIL';
  reason: string;
  effectiveN: number;
  candidateCalibratedConfidence: number;
}

/**
 * Runs each candidate through the existing Phase 4H champion/challenger gate. The gate gets the
 * EFFECTIVE sample size as `sampleSize` (never raw), and `championMetricValue` is always null - see
 * this module's header for why "improvement over champion" does not apply to a recalibration.
 * A PASS here only updates the OBSERVATIONAL learning_versions ledger - it never touches
 * agent_confidence_calibration and has zero effect on any live decision.
 *
 * Phase 7E addition (2026-08-27): the generic champion/challenger gate (evaluatePromotionGate)
 * only checks EFFECTIVE sample size, never whether the win rate is actually distinguishable from
 * chance - a real gap the Phase 7 forensic pass found (e.g. QuantEngine's 0.6-0.7 bucket: effective
 * N=11 is far below the floor anyway, but several buckets clear the sample-size floor while sitting
 * at ~50% effective win rate). Rather than changing evaluatePromotionGate itself (shared by every
 * other versionType this service governs, present and future), the additional statistical bar is
 * enforced HERE, scoped to calibration only: a candidate whose Wilson LOWER bound does not exceed
 * moderateCalibrationTrustMinWilsonLowerBound never reaches decidePromotion at all, so it can never
 * become CHAMPION - it stays CANDIDATE, fully audited (shadow version + evidence persist as normal),
 * just never promotable on today's evidence. This is what ModerateTierEvaluator.ts's calibration-
 * trust check (getChampion(...) !== null) ultimately relies on.
 */
export async function runCalibrationValidationCycle(now: Date = new Date()): Promise<CalibrationPromotionResult[]> {
  const candidates = await buildCalibrationCandidates(now);
  const results: CalibrationPromotionResult[] = [];

  for (const c of candidates) {
    const bucket: ConfidenceBucket = { low: c.bucketLow, high: c.bucketHigh };
    const versionType = calibrationVersionType(c.agentName, bucket);
    try {
      const versionId = await ChampionChallenger.createShadowVersion(
        versionType,
        JSON.stringify({
          candidateCalibratedConfidence: c.candidateCalibratedConfidence,
          effectiveN: c.effectiveN,
          effectiveWins: c.effectiveWins,
          wilsonLower: c.wilsonLower,
          wilsonUpper: c.wilsonUpper,
          bucketMidpoint: bucketMidpoint(bucket),
        }),
        `Cluster-corrected recalibration of ${c.agentName}'s ${bucket.low}-${bucket.high} bucket (effective N=${c.effectiveN} of raw N=${c.rawN}).`,
        now,
      );
      await ChampionChallenger.promoteToCandidate(versionId, JSON.stringify({ effectiveN: c.effectiveN }), c.effectiveN);

      const minWilsonLower = tradingSafety.moderateCalibrationTrustMinWilsonLowerBound;
      if (c.wilsonLower === null || c.wilsonLower <= minWilsonLower) {
        const reason = `Effective win rate (Wilson lower bound ${c.wilsonLower === null ? 'N/A' : c.wilsonLower.toFixed(4)}) is not ` +
          `statistically distinguishable from chance (>${minWilsonLower} required) - held at CANDIDATE, not promoted to CHAMPION.`;
        results.push({
          agentName: c.agentName, bucketLow: c.bucketLow, bucketHigh: c.bucketHigh,
          versionId, decision: 'FAIL', reason,
          effectiveN: c.effectiveN, candidateCalibratedConfidence: c.candidateCalibratedConfidence,
        });
        // Real bug fixed (Phase 9, 2026-08-31): this gate was added 2026-08-27, after several
        // (agent, bucket) champions had already been promoted under the prior, looser sample-size-
        // only rule. Without this, a champion promoted before the gate existed stays CHAMPION
        // forever - every subsequent cycle just holds the NEW candidate at CANDIDATE and leaves the
        // stale champion untouched, since decidePromotion() is never reached for a failing
        // candidate. isAgentBucketCalibrationTrustworthy() now also re-checks a champion's own
        // wilsonLower defensively, but retiring it here keeps the ledger itself honest (CHAMPION
        // means "currently above chance", not "was above chance under some now-superseded rule")
        // for any other consumer, not just this one call site.
        await ChampionChallenger.retireCurrentChampion(
          versionType,
          `Retired on re-evaluation: ${reason}`,
          now,
        );
        continue;
      }

      const decision = await ChampionChallenger.decidePromotion(versionId, versionType, {
        metricName: 'effective_sample_size',
        candidateMetricValue: c.candidateCalibratedConfidence,
        championMetricValue: null,
        sampleSize: c.effectiveN,
      }, now);
      results.push({
        agentName: c.agentName, bucketLow: c.bucketLow, bucketHigh: c.bucketHigh,
        versionId, decision: decision.decision, reason: decision.reason,
        effectiveN: c.effectiveN, candidateCalibratedConfidence: c.candidateCalibratedConfidence,
      });
    } catch (e) {
      logErrorSafely(`[CalibrationCandidateBuilder] validation cycle failed for ${versionType}`, e);
    }
  }

  return results;
}
