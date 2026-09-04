/**
 * Evaluation-horizon-mismatch remediation (2026-09-04) — retroactive comparison, read-only against
 * the live tables. Answers the actual question: "is a weak agent's measured BELOW_CHANCE/
 * NO_EDGE_DETECTABLE result real, or an artifact of grading it on a universal 60-minute clock that
 * doesn't match its own documented intended horizon?"
 *
 * CONTROLLED comparison (real bug found and fixed during this session, 2026-09-04): an earlier
 * version of this script compared each prediction's STORED prediction_outcomes.outcome (computed
 * whenever the live PredictionOutcomeEvaluator originally graded it, potentially days ago) against
 * a FRESH re-evaluation computed just now. That comparison is confounded: HistoricalDataGateway's
 * ohlcv_bars cache is not an immutable historical snapshot - it is a real, growing table that other
 * live processes (QuantEngine regime checks, backtests, other predictions' own evaluations)
 * continue to backfill for the same symbol/window over time. A re-query days later can see a MORE
 * COMPLETE bar set than the original grading did, silently shifting bars[0] (the entry price) and
 * therefore the computed outcome - completely independent of horizon. Verified directly: 100/100
 * predictions reproduced their stored outcome exactly when re-evaluated with the IDENTICAL horizon
 * moments after the original grade, but real drift appeared for older (days-old) graded predictions
 * even with an unchanged horizon (e.g. one AMD BUY: old actualReturn +0.0059/WIN, fresh
 * actualReturn -0.0018/LOSS, same actualPrice both times - proving entryPrice itself had shifted).
 *
 * This version isolates the ONE variable that matters (horizon) by computing BOTH the old
 * (universal 60-minute) and new (corrected, source-specific) results FRESH, in the same run,
 * against the SAME current cache state - never comparing against the stale stored value. Never
 * writes to prediction_outcomes or anywhere else.
 *
 * Usage: npx tsx scripts/reevaluate_horizons.ts
 */
import dotenv from 'dotenv';
dotenv.config();
process.env.ARGUS_DISABLE_MARKET_DATA_WS = 'true';

interface AgentAgg {
  agentKey: string;
  oldWins: number;
  oldLosses: number;
  newWins: number;
  newLosses: number;
  flippedLossToWin: number;
  flippedWinToLoss: number;
  reEvaluated: number;
  skippedNoData: number;
  horizonMs: number;
  horizonUnchanged: boolean;
}

const MAX_ROWS_PER_AGENT_KEY = 800; // keeps runtime bounded - two fresh real-bar evaluations per row

async function main() {
  const { db, sqliteDb } = await import('../src/server/db');
  const { agentPredictions } = await import('../src/server/db/schema');
  const { evaluatePrediction, EVALUATION_HORIZON_MS } = await import('../src/server/services/PredictionOutcomeEvaluator');
  const { resolveEvaluationHorizonMs, secondaryGroupKey } = await import('../src/server/research/predictionIndependencePolicy');
  const { TELEMETRY_PULSE_TRACE_PREFIX } = await import('../src/server/core/telemetryPulse');

  const predictions = await db.select().from(agentPredictions);

  const aggs = new Map<string, AgentAgg>();
  const rowsPerAgentKey = new Map<string, number>();

  let considered = 0;
  const now = Date.now();
  for (const p of predictions) {
    if (p.agentName === 'KronosEngine') continue; // out of scope - already has its own dedicated horizon
    if (p.traceId && p.traceId.startsWith(TELEMETRY_PULSE_TRACE_PREFIX)) continue;
    if (p.prediction !== 'BUY' && p.prediction !== 'SELL') continue; // HOLD-style rows were never graded WIN/LOSS

    const predTime = new Date(p.timestamp).getTime();
    const newHorizonMs = resolveEvaluationHorizonMs(p.agentName, p.reasoning);
    // Both horizons must have already elapsed for a fair fresh-vs-fresh comparison (the longer of
    // the two gates this - a prediction too recent for the corrected horizon is skipped entirely
    // rather than compared unfairly against a shorter old-horizon result that HAS had time to resolve).
    if (now - predTime < Math.max(EVALUATION_HORIZON_MS, newHorizonMs)) continue;

    const strategyKey = p.agentName === 'QuantEngine'
      ? (secondaryGroupKey('QuantEngine', p.reasoning) ?? 'QuantEngine(unattributed)').replace(/__COLD_START_BOOTSTRAP$/, '')
      : null;
    const agentKey = strategyKey ? `QuantEngine/${strategyKey}` : p.agentName;

    const seenForKey = rowsPerAgentKey.get(agentKey) ?? 0;
    if (seenForKey >= MAX_ROWS_PER_AGENT_KEY) continue;
    rowsPerAgentKey.set(agentKey, seenForKey + 1);

    if (!aggs.has(agentKey)) {
      aggs.set(agentKey, {
        agentKey, oldWins: 0, oldLosses: 0, newWins: 0, newLosses: 0,
        flippedLossToWin: 0, flippedWinToLoss: 0, reEvaluated: 0, skippedNoData: 0,
        horizonMs: newHorizonMs, horizonUnchanged: newHorizonMs === EVALUATION_HORIZON_MS,
      });
    }
    const agg = aggs.get(agentKey)!;

    considered += 1;
    // Both computed FRESH, right now, against the SAME current cache state - isolates horizon as
    // the only variable (see this file's header comment for why comparing against the stale stored
    // value was confounded).
    const [oldFresh, newFresh] = await Promise.all([
      evaluatePrediction(p.id, 'agent_predictions', p.symbol, p.prediction, predTime, EVALUATION_HORIZON_MS),
      newHorizonMs === EVALUATION_HORIZON_MS
        ? Promise.resolve(null) // no need to fetch twice when the horizon didn't change for this source
        : evaluatePrediction(p.id, 'agent_predictions', p.symbol, p.prediction, predTime, newHorizonMs),
    ]);
    const effectiveNew = newHorizonMs === EVALUATION_HORIZON_MS ? oldFresh : newFresh;

    if (!oldFresh || oldFresh.outcome === 'N_A' || !effectiveNew || effectiveNew.outcome === 'N_A') {
      agg.skippedNoData += 1;
      continue;
    }
    agg.reEvaluated += 1;
    if (oldFresh.outcome === 'WIN') agg.oldWins += 1;
    if (oldFresh.outcome === 'LOSS') agg.oldLosses += 1;
    if (effectiveNew.outcome === 'WIN') agg.newWins += 1;
    if (effectiveNew.outcome === 'LOSS') agg.newLosses += 1;
    if (oldFresh.outcome === 'LOSS' && effectiveNew.outcome === 'WIN') agg.flippedLossToWin += 1;
    if (oldFresh.outcome === 'WIN' && effectiveNew.outcome === 'LOSS') agg.flippedWinToLoss += 1;
  }

  console.log(`\nConsidered ${considered} directional (BUY/SELL) agent_predictions rows (capped at ${MAX_ROWS_PER_AGENT_KEY} per agent/strategy for runtime). Both columns computed FRESH in this run, same cache state - not compared against the stale stored grade.\n`);
  console.log(
    'Agent/Strategy'.padEnd(40)
    + 'Horizon'.padEnd(10)
    + 'Changed?'.padEnd(10)
    + 'Old(60m) W/L'.padEnd(15)
    + 'Old WinRate'.padEnd(14)
    + 'New(fixed) W/L'.padEnd(17)
    + 'New WinRate'.padEnd(14)
    + 'Flips L→W'.padEnd(11)
    + 'Flips W→L'.padEnd(11)
    + 'ReEval/Skip',
  );
  console.log('-'.repeat(170));

  const rows = Array.from(aggs.values()).sort((a, b) => (b.oldWins + b.oldLosses) - (a.oldWins + a.oldLosses));
  for (const a of rows) {
    const oldTotal = a.oldWins + a.oldLosses;
    const newTotal = a.newWins + a.newLosses;
    const oldWinRate = oldTotal > 0 ? (a.oldWins / oldTotal * 100).toFixed(1) + '%' : 'N/A';
    const newWinRate = newTotal > 0 ? (a.newWins / newTotal * 100).toFixed(1) + '%' : 'N/A';
    const horizonLabel = a.horizonMs >= 86400000 ? `${(a.horizonMs / 86400000).toFixed(1)}d` : `${(a.horizonMs / 60000).toFixed(0)}m`;
    console.log(
      a.agentKey.padEnd(40)
      + horizonLabel.padEnd(10)
      + (a.horizonUnchanged ? 'no (ctrl)' : 'YES').padEnd(10)
      + `${a.oldWins}/${a.oldLosses}`.padEnd(15)
      + oldWinRate.padEnd(14)
      + `${a.newWins}/${a.newLosses}`.padEnd(17)
      + newWinRate.padEnd(14)
      + String(a.flippedLossToWin).padEnd(11)
      + String(a.flippedWinToLoss).padEnd(11)
      + `${a.reEvaluated}/${a.skippedNoData}`,
    );
  }
  console.log(
    '\n"Changed?" = no (ctrl) means this source\'s horizon was NOT overridden (TechnicalAgent, NewsAgent, '
    + 'unattributed QuantEngine) - old and new columns should be numerically IDENTICAL (0 flips) for these, '
    + 'proving the comparison methodology itself introduces no drift. Any non-zero flip count on a "no (ctrl)" '
    + 'row indicates a remaining bug, not a horizon effect. Rows marked YES had a real, different corrected '
    + 'horizon applied - THOSE flip counts are the real answer to the horizon-mismatch question.\n',
  );

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
