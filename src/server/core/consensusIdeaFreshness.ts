import { tradingSafety } from '../config/tradingSafety';

/** Exclude stale in-memory votes from ChiefTrader so mismatched clocks cannot look like a live council. */
export function isConsensusIdeaFresh(receivedAt: number | undefined, now: number = Date.now()): boolean {
  if (receivedAt == null || !Number.isFinite(receivedAt)) return true;
  return now - receivedAt <= tradingSafety.consensusIdeaMaxAgeMs;
}
