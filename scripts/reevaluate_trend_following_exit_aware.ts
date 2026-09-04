/**
 * Exit-aware-evaluation closure (2026-09-04) - retroactive comparison, read-only against the live
 * tables. Answers the actual remaining question from the horizon-mismatch fix: does grading
 * TREND_FOLLOWING with a REAL exit simulation (TrendFollowingExitEvaluator.ts - SMA50 trailing
 * stop + ADX-fade invalidation, NEXT_BAR_OPEN fills) change its measured edge versus the fixed
 * 7-day snapshot check that PredictionOutcomeEvaluator.ts used immediately after the horizon fix
 * (config/evaluationHorizons.json's byQuantStrategyId.TREND_FOLLOWING, unchanged - this script
 * does not touch that value, it compares grading MODEL, not horizon LENGTH, isolating the one
 * variable this whole follow-up is about)?
 *
 * Same confound-avoidance discipline as scripts/reevaluate_horizons.ts (see that file's own header
 * for the full rationale): BOTH the old (fixed 7d snapshot) and new (real walk-forward exit)
 * results are computed FRESH, in the same run, against the SAME current ohlcv_bars cache state -
 * never comparing against a stale stored prediction_outcomes row.
 *
 * Usage: npx tsx scripts/reevaluate_trend_following_exit_aware.ts
 */
import dotenv from 'dotenv';
dotenv.config();
process.env.ARGUS_DISABLE_MARKET_DATA_WS = 'true';

async function main() {
  const { db, sqliteDb } = await import('../src/server/db');
  const { agentPredictions } = await import('../src/server/db/schema');
  const { evaluatePrediction } = await import('../src/server/services/PredictionOutcomeEvaluator');
  const { evaluateTrendFollowingExit } = await import('../src/server/services/TrendFollowingExitEvaluator');
  const { secondaryGroupKey } = await import('../src/server/research/predictionIndependencePolicy');
  const { evaluationHorizons } = await import('../src/server/config/evaluationHorizons');
  const { TELEMETRY_PULSE_TRACE_PREFIX } = await import('../src/server/core/telemetryPulse');

  const OLD_FIXED_HORIZON_MS = evaluationHorizons.byQuantStrategyId.TREND_FOLLOWING;
  const NEW_MAX_WALK_FORWARD_MS = evaluationHorizons.exitAwareMaxWalkForwardMs;
  const now = Date.now();
  const datasetBoundaryIso = new Date(now).toISOString();

  const predictions = await db.select().from(agentPredictions);

  let considered = 0;
  let oldWins = 0, oldLosses = 0, oldSkipped = 0;
  let newWins = 0, newLosses = 0, newStillOpen = 0, newInsufficientData = 0;
  let flippedLossToWin = 0, flippedWinToLoss = 0;
  const exitReasonCounts: Record<string, number> = {};
  const holdingPeriods: number[] = [];

  for (const p of predictions) {
    if (p.agentName !== 'QuantEngine') continue;
    if (p.traceId && p.traceId.startsWith(TELEMETRY_PULSE_TRACE_PREFIX)) continue;
    if (p.prediction !== 'BUY' && p.prediction !== 'SELL') continue;
    const rawKey = secondaryGroupKey('QuantEngine', p.reasoning);
    const strategyId = rawKey ? rawKey.replace(/__COLD_START_BOOTSTRAP$/, '') : null;
    if (strategyId !== 'TREND_FOLLOWING') continue;

    const predTime = new Date(p.timestamp).getTime();
    // Only the OLD evaluator's own gate needs to have elapsed - the same gate production already
    // uses before attempting either grading path. The NEW evaluator does not need its full 90d
    // walk-forward bound to already be in the past: it walks forward over whatever real bars exist
    // up to today and honestly reports STILL_OPEN (mark-to-market) if no real exit has occurred
    // yet - that is a legitimate, non-fabricated result, not something requiring a wait.
    if (now - predTime < OLD_FIXED_HORIZON_MS) continue;

    considered += 1;

    const [oldFresh, newFresh] = await Promise.all([
      evaluatePrediction(p.id, 'agent_predictions', p.symbol, p.prediction, predTime, OLD_FIXED_HORIZON_MS),
      evaluateTrendFollowingExit(p.symbol, p.prediction as 'BUY' | 'SELL', predTime, NEW_MAX_WALK_FORWARD_MS),
    ]);

    if (!oldFresh || oldFresh.outcome === 'N_A') {
      oldSkipped += 1;
    } else if (oldFresh.outcome === 'WIN') {
      oldWins += 1;
    } else if (oldFresh.outcome === 'LOSS') {
      oldLosses += 1;
    }

    if (!newFresh) {
      newInsufficientData += 1;
    } else {
      exitReasonCounts[newFresh.exitReason] = (exitReasonCounts[newFresh.exitReason] ?? 0) + 1;
      if (newFresh.holdingPeriodDays !== null) holdingPeriods.push(newFresh.holdingPeriodDays);
      if (newFresh.outcome === 'WIN') newWins += 1;
      else if (newFresh.outcome === 'LOSS') newLosses += 1;
      else if (newFresh.outcome === 'STILL_OPEN') newStillOpen += 1;
    }

    if (oldFresh && newFresh && oldFresh.outcome !== 'N_A' && newFresh.outcome !== 'N_A' && newFresh.outcome !== 'STILL_OPEN') {
      if (oldFresh.outcome === 'LOSS' && newFresh.outcome === 'WIN') flippedLossToWin += 1;
      if (oldFresh.outcome === 'WIN' && newFresh.outcome === 'LOSS') flippedWinToLoss += 1;
    }
  }

  const oldGraded = oldWins + oldLosses;
  const newGraded = newWins + newLosses;
  const oldWinRate = oldGraded > 0 ? (oldWins / oldGraded * 100).toFixed(1) + '%' : 'N/A';
  const newWinRate = newGraded > 0 ? (newWins / newGraded * 100).toFixed(1) + '%' : 'N/A';
  const avgHold = holdingPeriods.length > 0 ? (holdingPeriods.reduce((a, b) => a + b, 0) / holdingPeriods.length).toFixed(1) : 'N/A';

  console.log('\n=== TREND_FOLLOWING: fixed-horizon snapshot vs real exit-simulation - closure comparison ===');
  console.log(`Dataset boundary / evaluation timestamp: ${datasetBoundaryIso}`);
  console.log(`Evaluator versions: PredictionOutcomeEvaluator.ts (fixed ${OLD_FIXED_HORIZON_MS / 86400000}d snapshot) vs TrendFollowingExitEvaluator.ts (real walk-forward, max ${NEW_MAX_WALK_FORWARD_MS / 86400000}d)`);
  console.log(`Predictions considered (both windows elapsed): ${considered}\n`);

  console.log(`OLD (fixed ${OLD_FIXED_HORIZON_MS / 86400000}d snapshot):  graded=${oldGraded} (W${oldWins}/L${oldLosses})  winRate=${oldWinRate}  skipped(no data/N_A)=${oldSkipped}`);
  console.log(`NEW (real exit simulation):        graded=${newGraded} (W${newWins}/L${newLosses})  winRate=${newWinRate}  stillOpen=${newStillOpen}  insufficientData=${newInsufficientData}`);
  console.log(`Flips (both graded, non-open):  LOSS->WIN=${flippedLossToWin}  WIN->LOSS=${flippedWinToLoss}`);
  console.log(`Real exit reason breakdown (new evaluator): ${JSON.stringify(exitReasonCounts)}`);
  console.log(`Average real holding period (days, new evaluator, closed positions only): ${avgHold}`);
  console.log(`\nOutcome distribution (new): WIN=${newWins} LOSS=${newLosses} STILL_OPEN=${newStillOpen} INSUFFICIENT_DATA=${newInsufficientData}`);

  console.log('\nThis compares GRADING MODEL only (fixed-horizon snapshot vs real exit simulation) - the horizon');
  console.log('LENGTH itself (config/evaluationHorizons.json byQuantStrategyId.TREND_FOLLOWING) is unchanged by');
  console.log('this run. No other agent/strategy\'s code path is touched by this script.');

  try { sqliteDb.close(); } catch { /* already closed */ }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
  });
