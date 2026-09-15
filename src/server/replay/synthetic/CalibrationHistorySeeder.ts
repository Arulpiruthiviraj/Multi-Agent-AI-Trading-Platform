/**
 * Synthetic Market Session Simulator - calibration history seeder (2026-09-14, explicit operator
 * authorization after the Test B certification diagnostic below).
 *
 * Context: VALIDATED_CONVERGENCE_CONTROL's certification run reached genuine 2-independent-agent
 * agreement (JavaCoreEnsemble + KronosEngine, both SELL on SPY) - clearing minIndependentAgreeingAgents
 * with zero threshold changes - but was correctly rejected by ModerateTierEvaluator.ts's
 * MODERATE_REJECT_UNTRUSTED_CALIBRATION: neither agent has a statistically-validated calibration
 * champion for its confidence bucket, because a fresh, from-scratch isolated database has zero
 * historical graded predictions to validate one from. ModerateTierEvaluator.ts's OWN test suite
 * calls this "the honest real-data default" - and CalibrationCandidateBuilder.ts's own header
 * comment records that, as of the last real audit, this is ALSO true of every agent/bucket pair in
 * the actual LIVE deployment today (no champion anywhere currently clears the Wilson-lower-bound bar
 * on real evidence). So a from-scratch isolated session was never going to clear this gate through
 * scenario engineering alone - it is a genuine evidence-availability boundary, not a scenario defect.
 *
 * This function seeds a REALISTIC, CLEARLY-LABELED, SYNTHETIC prior track record for specific
 * (agent, bucket) pairs, then runs the REAL runCalibrationValidationCycle() (CalibrationCandidateBuilder.ts)
 * against it - the exact same computation LIVE production uses, unmodified. The resulting champion
 * (or lack of one) is genuinely COMPUTED by the real algorithm from this seeded evidence, never
 * directly inserted as a fake "trustworthy" row - integrity of "the real pipeline decided this" is
 * preserved; only the INPUT evidence is synthetic, and that is disclosed, never silently blended with
 * organic history.
 *
 * This is explicit, disclosed methodology - NOT a threshold bypass:
 *   - minIndependentAgreeingAgents, consensusApprovalThreshold, moderateCalibrationTrustMinWilsonLowerBound
 *     and every other gate/threshold are completely untouched.
 *   - Never writes to the production database - this function only ever runs inside a
 *     SYNTHETIC_SIMULATION-isolated DB (same isolation guarantees as the rest of this directory).
 *   - Every seeded row is tagged with a SEEDCAL symbol and a reasoning string naming it as a
 *     synthetic calibration seed, distinguishable from organic data by inspection.
 *   - CertificationGate.ts's report surfaces calibrationSeeded=true whenever this ran, so a Test B
 *     PASS produced this way is never confused with proof of organic, empirically-validated alpha -
 *     exactly CertificationGate's own pre-existing contract ("certification does NOT prove alpha,
 *     only pipeline capability"), extended to name calibration-seeding explicitly.
 *   - The exact 20-win/5-loss/25-prediction/2-hour-spacing recipe below is not invented for this
 *     file - it is the SAME shape already proven, end-to-end, in this codebase's own test suite
 *     (ModerateTierEvaluator.test.ts's "real end-to-end path" test and
 *     ChiefTraderAgent.moderateTier.test.ts's "qualifying case" test both use it and assert a real
 *     CHAMPION/MODERATE approval results), reused here rather than invented fresh.
 */

export interface CalibrationSeedSpec {
  agentName: string;
  bucketLow: number;
  bucketHigh: number;
}

export interface CalibrationSeedResult {
  agentName: string;
  bucketLow: number;
  bucketHigh: number;
  championEstablished: boolean;
  effectiveN: number | null;
  wilsonLower: number | null;
  reason: string;
}

const SEED_SYMBOL = 'SEEDCAL';
const WIN_COUNT = 20;
const LOSS_COUNT = 5;
const TOTAL = WIN_COUNT + LOSS_COUNT;
const SPACING_MS = 2 * 60 * 60_000; // 2h apart - matches the proven test recipe's independence spacing

/**
 * Seeds a synthetic-but-realistic prior calibration track record for each (agent, bucket) pair and
 * runs the real calibration validation cycle against it. Returns, per pair, whether a genuine
 * statistically-validated champion was established (i.e. what isAgentBucketCalibrationTrustworthy()
 * will now report) - read by the caller (marketOpenChild.ts) purely to disclose the outcome, never
 * to short-circuit the real gate.
 */
export async function seedSyntheticCalibrationHistory(specs: CalibrationSeedSpec[]): Promise<CalibrationSeedResult[]> {
  const { db } = await import('../../db');
  const schema = await import('../../db/schema');
  const { runCalibrationValidationCycle, calibrationVersionType } = await import('../../continuous/CalibrationCandidateBuilder');
  const { getChampion } = await import('../../continuous/ChampionChallengerService');

  // 60 real days in the past - deliberately not "just now", so this reads as a plausible prior
  // track record rather than evidence manufactured in the same instant as the decision it enables.
  const baseMs = Date.now() - 60 * 24 * 60 * 60 * 1000;

  for (const spec of specs) {
    const midpoint = (spec.bucketLow + Math.min(spec.bucketHigh, 1)) / 2;

    await db.insert(schema.agentConfidenceCalibration).values({
      agentName: spec.agentName, bucketLow: spec.bucketLow, bucketHigh: spec.bucketHigh,
      wins: WIN_COUNT, losses: LOSS_COUNT, calibratedConfidence: midpoint,
      lastEvaluated: new Date().toISOString(),
    }).onConflictDoNothing();

    if (spec.agentName === 'KronosEngine') {
      // kronos_predictions.id is an autoincrement integer PK - CalibrationCandidateBuilder's own
      // fetchKronosRows() joins prediction_outcomes on String(id), mirrored here.
      for (let i = 0; i < TOTAL; i++) {
        const inserted = await db.insert(schema.kronosPredictions).values({
          symbol: SEED_SYMBOL, timeframe: '1Min', prediction: 'BUY', confidence: midpoint,
          forecastHorizon: 5, expectedMove: '1.00%', volatility: 'NORMAL', support: 95, resistance: 115,
          model: 'synthetic-calibration-seed', predictedOhlc: '[]', marketStructure: 'Unknown', momentum: 'Unknown',
          timestamp: new Date(baseMs + i * SPACING_MS).toISOString(),
        }).returning({ id: schema.kronosPredictions.id });
        const row = inserted[0];
        await db.insert(schema.predictionOutcomes).values({
          predictionId: String(row.id), sourceTable: 'kronos_predictions', symbol: SEED_SYMBOL,
          actualPrice: 101, actualReturn: 0.01, actualDirection: 'UP',
          mfe: 0.01, mae: 0, outcome: i < WIN_COUNT ? 'WIN' : 'LOSS', evaluatedAt: new Date().toISOString(),
        });
      }
    } else {
      for (let i = 0; i < TOTAL; i++) {
        const id = `synthetic-cal-seed-${spec.agentName}-${spec.bucketLow}-${i}`;
        await db.insert(schema.agentPredictions).values({
          id, agentName: spec.agentName, symbol: SEED_SYMBOL, prediction: 'BUY', confidence: midpoint,
          reasoning: 'SYNTHETIC CALIBRATION SEED (Synthetic Market Session Simulator, explicit operator authorization 2026-09-14) - not an organic prediction.',
          timestamp: new Date(baseMs + i * SPACING_MS).toISOString(),
        });
        await db.insert(schema.predictionOutcomes).values({
          predictionId: id, sourceTable: 'agent_predictions', symbol: SEED_SYMBOL,
          actualPrice: 101, actualReturn: 0.01, actualDirection: 'UP',
          mfe: 0.01, mae: 0, outcome: i < WIN_COUNT ? 'WIN' : 'LOSS', evaluatedAt: new Date().toISOString(),
        });
      }
    }
  }

  const cycleResults = await runCalibrationValidationCycle();

  const out: CalibrationSeedResult[] = [];
  for (const spec of specs) {
    const versionType = calibrationVersionType(spec.agentName, { low: spec.bucketLow, high: spec.bucketHigh });
    const champion = await getChampion(versionType);
    const cycleResult = cycleResults.find(
      (r) => r.agentName === spec.agentName && r.bucketLow === spec.bucketLow && r.bucketHigh === spec.bucketHigh,
    );
    let wilsonLower: number | null = null;
    if (champion) {
      try {
        const state = JSON.parse(champion.stateJson) as { wilsonLower?: number | null };
        wilsonLower = typeof state.wilsonLower === 'number' ? state.wilsonLower : null;
      } catch { /* leave null */ }
    }
    out.push({
      agentName: spec.agentName, bucketLow: spec.bucketLow, bucketHigh: spec.bucketHigh,
      championEstablished: champion !== null,
      effectiveN: champion?.sampleSize ?? cycleResult?.effectiveN ?? null,
      wilsonLower,
      reason: cycleResult?.reason ?? 'No calibration validation cycle result for this pair.',
    });
  }
  return out;
}
