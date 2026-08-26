/**
 * Champion/Challenger (Section 22). Data model + real statistical comparison only — NOT wired to
 * any live paper-trading override, since 0 strategies have ever graduated (there is no real
 * champion trading today to compare against). A challenger never affects production trading
 * until validated (enforced structurally: this module never imports OMS/RiskEngine/BrokerManager
 * and never calls emitTradeIdea).
 */
import { wilsonInterval } from '../effectiveSampleSize';
import { setChampionStatus } from './StrategyCandidateLedger';
import type { StrategyCandidateRecord } from './types';

export interface ChallengerComparison {
  shouldPromoteChallenger: boolean;
  reason: string;
}

/**
 * A challenger must beat the champion by a REAL, non-overlapping statistical margin — never
 * merely "candidate P&L > champion P&L" (Section 12's explicit warning). Uses the same
 * Wilson-interval machinery this codebase already relies on elsewhere (AlphaEdgeResearch.ts):
 * the challenger's lower confidence bound must exceed the champion's own point estimate.
 */
export function compareChallengerToChampion(
  challenger: StrategyCandidateRecord,
  champion: StrategyCandidateRecord | null,
): ChallengerComparison {
  const c = challenger.lastEvaluation;
  if (!c || c.metrics.tradeCount === 0 || c.metrics.winRate === null) {
    return { shouldPromoteChallenger: false, reason: 'Challenger has no evaluated trades yet.' };
  }
  if (!champion || !champion.lastEvaluation || champion.lastEvaluation.metrics.winRate === null) {
    return { shouldPromoteChallenger: false, reason: 'No incumbent champion evaluation to compare against — cannot promote without a real comparison.' };
  }

  const wins = Math.round(c.metrics.winRate * c.metrics.tradeCount);
  const challengerInterval = wilsonInterval(wins, c.metrics.tradeCount);
  const championWinRate = champion.lastEvaluation.metrics.winRate;

  if (challengerInterval.lower === null || challengerInterval.lower <= championWinRate) {
    return {
      shouldPromoteChallenger: false,
      reason: `Challenger's 95% win-rate lower bound (${challengerInterval.lower?.toFixed(3)}) does not exceed champion's win rate (${championWinRate.toFixed(3)}) — not a statistically meaningful improvement.`,
    };
  }
  if ((c.metrics.expectancy ?? 0) <= 0) {
    return { shouldPromoteChallenger: false, reason: 'Challenger expectancy is not positive — real win-rate edge alone is not sufficient.' };
  }
  return {
    shouldPromoteChallenger: true,
    reason: `Challenger's win-rate lower bound (${challengerInterval.lower.toFixed(3)}) exceeds champion's win rate (${championWinRate.toFixed(3)}) with positive expectancy (${c.metrics.expectancy}).`,
  };
}

export async function designateChallenger(candidateId: string, reason: string): Promise<void> {
  await setChampionStatus(candidateId, 'CHALLENGER', reason);
}

export async function promoteChallengerToChampion(challengerCandidateId: string, previousChampionId: string | null, reason: string): Promise<void> {
  if (previousChampionId) {
    await setChampionStatus(previousChampionId, 'RETIRED', `Superseded by ${challengerCandidateId}: ${reason}`);
  }
  await setChampionStatus(challengerCandidateId, 'CHAMPION', reason);
}
