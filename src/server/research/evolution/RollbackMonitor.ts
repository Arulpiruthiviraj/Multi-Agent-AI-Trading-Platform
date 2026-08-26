/**
 * Automatic retirement & rollback (Sections 20/21). Statistical, not "one or two losses" —
 * reuses the same wilsonInterval machinery as ChampionChallenger.ts rather than inventing a
 * second threshold concept. "Never leave Argus without a known-good strategy" is satisfied
 * structurally: rollback always designates the immediately-previous CHAMPION (never null unless
 * none ever existed), and retirement never deletes a candidate row — only marks championStatus.
 */
import { wilsonInterval } from '../effectiveSampleSize';
import { setChampionStatus, transitionCandidate } from './StrategyCandidateLedger';
import type { StrategyCandidateRecord } from './types';

export interface DegradationCheck {
  shouldRollback: boolean;
  reason: string;
}

/**
 * `baselineWinRate` is the champion's own win rate AT PROMOTION TIME (not re-derived from live
 * data here, so this module never invents a moving baseline). `recent` is a fresh evaluation of
 * the SAME candidate against newer data. Rollback only when the recent lower confidence bound
 * falls statistically below the original baseline — never on a small, expected sample wobble.
 */
export function checkForDegradation(champion: StrategyCandidateRecord, recentWins: number, recentTrades: number): DegradationCheck {
  if (!champion.lastEvaluation || champion.lastEvaluation.metrics.winRate === null) {
    return { shouldRollback: false, reason: 'No baseline evaluation recorded for this champion — cannot assess degradation.' };
  }
  if (recentTrades === 0) {
    return { shouldRollback: false, reason: 'No recent trades yet — nothing to assess.' };
  }
  const baseline = champion.lastEvaluation.metrics.winRate;
  const recent = wilsonInterval(recentWins, recentTrades);
  if (recent.upper === null || recent.upper >= baseline) {
    return { shouldRollback: false, reason: `Recent win-rate upper bound (${recent.upper?.toFixed(3)}) still reaches the ${baseline.toFixed(3)} baseline — not statistically confirmed degradation.` };
  }
  return {
    shouldRollback: true,
    reason: `Recent win-rate upper bound (${recent.upper.toFixed(3)}) falls below the champion's original baseline (${baseline.toFixed(3)}) over ${recentTrades} real trades — statistically confirmed degradation.`,
  };
}

/** Rolls back to the known-good previous champion. Never leaves Argus with no designated champion
 *  if one previously existed — the retired candidate's row is never deleted, only re-labeled. */
export async function rollbackToPreviousChampion(degradedCandidateId: string, previousChampionId: string, reason: string): Promise<void> {
  await setChampionStatus(degradedCandidateId, 'RETIRED', reason);
  await transitionCandidate({
    candidateId: degradedCandidateId,
    toStatus: 'DEGRADED',
    reason,
    eventType: 'STRATEGY_ROLLBACK',
  });
  await setChampionStatus(previousChampionId, 'CHAMPION', `Restored after rollback of ${degradedCandidateId}: ${reason}`);
}

export async function retireCandidate(candidateId: string, reason: string): Promise<void> {
  await setChampionStatus(candidateId, 'RETIRED', reason);
  await transitionCandidate({ candidateId, toStatus: 'RETIRED', reason, eventType: 'STRATEGY_RETIRED' });
}
