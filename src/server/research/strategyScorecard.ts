/**
 * Phase 14 (2026-08-31 historical-replay & fair-exploration mission), Objective 7: complete
 * strategy-level report for all 21 enabled strategies, combining ALREADY-BUILT real reports rather
 * than recomputing anything - never a duplicate implementation:
 *   - strategySelectionReplay.ts's buildStrategyFairnessReport() - evaluation/selection/emission
 *     counts (real, from quant_assessments + agent_predictions)
 *   - strategyProfitabilityReport.ts's buildStrategyProfitabilityReport() - real organic net P&L
 *     from real closed round-trips (Phase 13)
 *   - StrategyEmissionEligibility.ts's getStrategyLifecycleStatus() - current real-selection
 *     eligibility (Phase 13/14)
 *   - replayWalkForward.ts's summarizeWalkForwardConsistency() (Phase 14, this mission) - OOS/
 *     walk-forward-style replay evidence, passed in by the caller since running replay is a real,
 *     separate, potentially long-running operation this report must never trigger itself.
 *
 * Every quantitative field here is labeled by evidence category in formatStrategyScorecard() -
 * organic real data, replay-simulated data, and "no evidence" are never blended into one number.
 */
import { buildStrategyFairnessReport, type StrategyFairnessRow } from './strategySelectionReplay';
import { buildStrategyProfitabilityReport, type StrategyProfitabilityRow } from './strategyProfitabilityReport';
import { getStrategyLifecycleStatus, type StrategyLifecycleStatus } from '../quant/strategies/StrategyEmissionEligibility';
import type { StrategyWalkForwardVerdict } from './replayWalkForward';

export interface StrategyScorecardRow {
  strategyId: string;
  isCore: boolean;
  lifecycleStatus: StrategyLifecycleStatus;
  /** REAL LIVE/HISTORICAL DATA (strategySelectionReplay.ts) */
  totalEvaluations: number;
  rank1Core: number;
  predictedWinner: number;
  realEmissions: number;
  realGradedOutcomes: number;
  fairnessStatus: StrategyFairnessRow['status'];
  /** REAL ORGANIC DATA (strategyProfitabilityReport.ts) - null if zero real closed round-trips exist. */
  organic: {
    tradeCount: number;
    winRate: number | null;
    wilsonLower: number | null;
    netPnl: number;
    profitFactor: number | null;
    status: StrategyProfitabilityRow['status'];
  } | null;
  /** REPLAY-SIMULATED DATA (replayWalkForward.ts) - explicitly never organic; null if no replay was supplied/run for this strategy. */
  replay: {
    totalClosedTrades: number;
    totalNetPnl: number;
    status: StrategyWalkForwardVerdict['status'];
    reason: string;
  } | null;
  /** Final, honest classification - see the mission's own required vocabulary. */
  classification:
    | 'NO_EVIDENCE'
    | 'NEGATIVE_EVIDENCE'
    | 'PROMISING_BUT_INSUFFICIENT'
    | 'OOS_SURVIVOR'
    | 'WALK_FORWARD_SURVIVOR'
    | 'PAPER_VALIDATED'
    | 'PROFITABLE_PAPER_STRATEGY';
}

const CORE_STRATEGY_IDS = new Set(['MOMENTUM_BREAKOUT', 'PULLBACK_CONTINUATION', 'MEAN_REVERSION', 'TREND_FOLLOWING', 'RANGE_REVERSION']);

function classify(
  organic: StrategyScorecardRow['organic'],
  replay: StrategyScorecardRow['replay'],
  lifecycleStatus: StrategyLifecycleStatus,
): StrategyScorecardRow['classification'] {
  if (lifecycleStatus === 'RETIRED' || lifecycleStatus === 'DEGRADED') return 'NEGATIVE_EVIDENCE';

  // Organic paper evidence is the strongest signal available - a strategy only reaches
  // PROFITABLE_PAPER_STRATEGY via real, organic, statistically-adequate paper fills.
  if (organic && organic.tradeCount >= 20 && organic.wilsonLower !== null && organic.wilsonLower > 0.5 && organic.netPnl > 0) {
    return 'PROFITABLE_PAPER_STRATEGY';
  }
  if (organic && organic.tradeCount > 0 && organic.status === 'NET_NEGATIVE') return 'NEGATIVE_EVIDENCE';
  if (organic && organic.tradeCount > 0 && organic.tradeCount < 20) return 'PROMISING_BUT_INSUFFICIENT';

  // No organic paper evidence yet - fall back to replay-simulated evidence, explicitly one tier
  // below organic (replay surviving walk-forward is NOT the same as live paper validation).
  if (replay) {
    if (replay.status === 'CONSISTENT_ABOVE_CHANCE' && replay.totalNetPnl > 0) return 'WALK_FORWARD_SURVIVOR';
    if (replay.status === 'CONSISTENT_BELOW_CHANCE' || replay.status === 'INCONSISTENT') return 'NEGATIVE_EVIDENCE';
    if (replay.status === 'INSUFFICIENT_SAMPLE' && replay.totalClosedTrades > 0) return 'PROMISING_BUT_INSUFFICIENT';
  }
  return 'NO_EVIDENCE';
}

export async function buildStrategyScorecard(
  replayVerdicts: StrategyWalkForwardVerdict[] = [],
): Promise<StrategyScorecardRow[]> {
  const [fairnessRows, profitabilityRows] = await Promise.all([
    buildStrategyFairnessReport(),
    buildStrategyProfitabilityReport(),
  ]);
  const fairnessByStrategy = new Map(fairnessRows.map((r) => [r.strategyId, r]));
  const profitByStrategy = new Map(profitabilityRows.map((r) => [r.strategyId, r]));
  const replayByStrategy = new Map(replayVerdicts.map((r) => [r.strategyId, r]));

  // Union of every real evidence source's strategy ids - a strategy with real organic
  // profitability or a real replay verdict must never be silently dropped just because it lacks
  // quant_assessments/agent_predictions rows (buildStrategyFairnessReport()'s own scope).
  const allStrategyIds = new Set<string>([
    ...fairnessRows.map((r) => r.strategyId),
    ...profitabilityRows.map((r) => r.strategyId),
    ...replayVerdicts.map((r) => r.strategyId),
  ]);

  const rows: StrategyScorecardRow[] = [];
  for (const strategyId of allStrategyIds) {
    const f = fairnessByStrategy.get(strategyId);
    const lifecycleStatus = await getStrategyLifecycleStatus(strategyId);
    const profit = profitByStrategy.get(strategyId);
    const replayVerdict = replayByStrategy.get(strategyId);

    const organic: StrategyScorecardRow['organic'] = profit && profit.tradeCount > 0 ? {
      tradeCount: profit.tradeCount, winRate: profit.winRate, wilsonLower: profit.wilsonLower,
      netPnl: profit.netPnl, profitFactor: profit.profitFactor, status: profit.status,
    } : null;

    const replay: StrategyScorecardRow['replay'] = replayVerdict ? {
      totalClosedTrades: replayVerdict.totalClosedTrades, totalNetPnl: replayVerdict.totalNetPnl,
      status: replayVerdict.status, reason: replayVerdict.reason,
    } : null;

    rows.push({
      strategyId,
      isCore: f?.isCore ?? CORE_STRATEGY_IDS.has(strategyId),
      lifecycleStatus,
      totalEvaluations: f?.totalEvaluations ?? 0,
      rank1Core: f?.rank1Core ?? 0,
      predictedWinner: f?.predictedWinner ?? 0,
      realEmissions: f?.realEmissions ?? 0,
      realGradedOutcomes: f?.realGradedOutcomes ?? 0,
      fairnessStatus: f?.status ?? 'NEVER_EVALUATED',
      organic,
      replay,
      classification: classify(organic, replay, lifecycleStatus),
    });
  }
  return rows.sort((a, b) => (b.isCore ? 1 : 0) - (a.isCore ? 1 : 0) || b.realEmissions - a.realEmissions);
}

export function formatStrategyScorecard(rows: StrategyScorecardRow[]): string {
  const idWidth = Math.max(24, ...rows.map((r) => r.strategyId.length + 2), 1);
  const lines = [
    '21-STRATEGY SCORECARD - evidence categories are never blended:',
    '  ORGANIC = real live/paper fills. REPLAY = simulated historical fills (never organic).',
    '  NO_EVIDENCE / NEGATIVE_EVIDENCE / PROMISING_BUT_INSUFFICIENT / OOS_SURVIVOR /',
    '  WALK_FORWARD_SURVIVOR / PAPER_VALIDATED / PROFITABLE_PAPER_STRATEGY',
    '----------------------------------------------------------------------------------------',
    'Strategy'.padEnd(idWidth) + 'Core'.padEnd(6) + 'Lifecycle'.padEnd(20) + 'RealEmit'.padEnd(10)
      + 'OrganicN'.padEnd(10) + 'OrganicPnL'.padEnd(12) + 'ReplayN'.padEnd(9) + 'ReplayPnL'.padEnd(11) + 'Classification',
  ];
  for (const r of rows) {
    lines.push(
      r.strategyId.padEnd(idWidth)
      + (r.isCore ? 'YES' : 'no').padEnd(6)
      + r.lifecycleStatus.padEnd(20)
      + String(r.realEmissions).padEnd(10)
      + String(r.organic?.tradeCount ?? 0).padEnd(10)
      + (r.organic ? `$${r.organic.netPnl.toFixed(2)}` : 'N/A').padEnd(12)
      + String(r.replay?.totalClosedTrades ?? 0).padEnd(9)
      + (r.replay ? `$${r.replay.totalNetPnl.toFixed(2)}` : 'N/A').padEnd(11)
      + r.classification,
    );
  }
  return lines.join('\n');
}
