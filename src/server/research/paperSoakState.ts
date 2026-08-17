/**
 * Paper soak state machine (evidence-derived). Never invents trades or skips states.
 *
 * NOT_READY → READY_FOR_PAPER_SOAK → PAPER_SOAK_RUNNING → PAPER_EVIDENCE_ACCUMULATING
 * → PAPER_VALIDATION_COMPLETE
 *
 * Legacy aliases SOAK_IN_PROGRESS / SOAK_FLOOR_MET remain for older clients.
 */
import { researchSafety } from '../config/researchSafety';

export type PaperSoakStatus =
  | 'NOT_READY'
  | 'READY_FOR_PAPER_SOAK'
  | 'PAPER_SOAK_RUNNING'
  | 'PAPER_EVIDENCE_ACCUMULATING'
  | 'PAPER_VALIDATION_COMPLETE';

export interface PaperSoakSnapshot {
  status: PaperSoakStatus;
  legacyStatus: 'SOAK_IN_PROGRESS' | 'SOAK_FLOOR_MET';
  minPaperTrades: number;
  minPaperSessions: number;
  closedTradeCount: number;
  sessionCount: number;
  remainingTrades: number;
  remainingSessions: number;
  tradingState: string;
  reconciliationBlocking: boolean;
  note: string;
  live: 'NO-GO';
}

export function derivePaperSoakStatus(input: {
  closedTradeCount: number;
  sessionCount: number;
  tradingState: string;
  reconciliationBlocking?: boolean;
  minPaperTrades?: number;
  minPaperSessions?: number;
}): PaperSoakSnapshot {
  const minPaperTrades = input.minPaperTrades ?? researchSafety.minPaperTrades;
  const minPaperSessions = input.minPaperSessions ?? researchSafety.minPaperSessions;
  const closed = Math.max(0, input.closedTradeCount | 0);
  const sessions = Math.max(0, input.sessionCount | 0);
  const floorsMet = closed >= minPaperTrades && sessions >= minPaperSessions;
  const reconBlocking = !!input.reconciliationBlocking;
  const tradingEnabled = input.tradingState === 'TRADING_ENABLED';

  let status: PaperSoakStatus;
  if (!tradingEnabled || reconBlocking) {
    status = 'NOT_READY';
  } else if (floorsMet) {
    status = 'PAPER_VALIDATION_COMPLETE';
  } else if (closed === 0 && sessions === 0) {
    status = 'READY_FOR_PAPER_SOAK';
  } else if (closed > 0 && !floorsMet) {
    status = 'PAPER_EVIDENCE_ACCUMULATING';
  } else {
    status = 'PAPER_SOAK_RUNNING';
  }

  return {
    status,
    legacyStatus: floorsMet ? 'SOAK_FLOOR_MET' : 'SOAK_IN_PROGRESS',
    minPaperTrades,
    minPaperSessions,
    closedTradeCount: closed,
    sessionCount: sessions,
    remainingTrades: Math.max(0, minPaperTrades - closed),
    remainingSessions: Math.max(0, minPaperSessions - sessions),
    tradingState: input.tradingState,
    reconciliationBlocking: reconBlocking,
    note: 'Organic PAPER FILLED SELL only. Replay/DIAG/EXTERNAL_SYNC/PRE_EXISTING excluded. Cannot be fabricated. LIVE=NO-GO.',
    live: 'NO-GO',
  };
}
