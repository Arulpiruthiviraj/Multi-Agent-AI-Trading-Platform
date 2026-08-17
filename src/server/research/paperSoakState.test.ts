import { describe, it, expect } from 'vitest';
import { derivePaperSoakStatus } from './paperSoakState';
import { classifyTradeEnvironment, isOrganicClosedPaper } from './organicPaper';

describe('paperSoakState', () => {
  it('does not skip states: paused → NOT_READY', () => {
    const s = derivePaperSoakStatus({
      closedTradeCount: 0,
      sessionCount: 0,
      tradingState: 'TRADING_PAUSED',
    });
    expect(s.status).toBe('NOT_READY');
    expect(s.legacyStatus).toBe('SOAK_IN_PROGRESS');
    expect(s.live).toBe('NO-GO');
  });

  it('READY_FOR_PAPER_SOAK when enabled with zero organic evidence', () => {
    const s = derivePaperSoakStatus({
      closedTradeCount: 0,
      sessionCount: 0,
      tradingState: 'TRADING_ENABLED',
    });
    expect(s.status).toBe('READY_FOR_PAPER_SOAK');
  });

  it('PAPER_EVIDENCE_ACCUMULATING below floors', () => {
    const s = derivePaperSoakStatus({
      closedTradeCount: 3,
      sessionCount: 1,
      tradingState: 'TRADING_ENABLED',
      minPaperTrades: 30,
      minPaperSessions: 10,
    });
    expect(s.status).toBe('PAPER_EVIDENCE_ACCUMULATING');
    expect(s.remainingTrades).toBe(27);
  });

  it('PAPER_VALIDATION_COMPLETE only when floors met', () => {
    const s = derivePaperSoakStatus({
      closedTradeCount: 30,
      sessionCount: 10,
      tradingState: 'TRADING_ENABLED',
      minPaperTrades: 30,
      minPaperSessions: 10,
    });
    expect(s.status).toBe('PAPER_VALIDATION_COMPLETE');
    expect(s.legacyStatus).toBe('SOAK_FLOOR_MET');
  });
});

describe('organicPaper exclusions', () => {
  it('excludes REPLAY, HISTORICAL_SIMULATION, EXTERNAL_SYNC, DIAG symbols', () => {
    expect(classifyTradeEnvironment({ executionEnvironment: 'REPLAY' })).toBe('REPLAY');
    expect(classifyTradeEnvironment({ executionEnvironment: 'HISTORICAL_SIMULATION' })).toBe('UNKNOWN');
    expect(classifyTradeEnvironment({ executionEnvironment: 'EXTERNAL_SYNC' })).toBe('UNKNOWN');
    expect(classifyTradeEnvironment({ executionEnvironment: 'PRE_EXISTING_RECONCILED' })).toBe('UNKNOWN');
    expect(isOrganicClosedPaper({
      status: 'FILLED', side: 'SELL', profitLoss: 1, executionEnvironment: 'PAPER', symbol: 'DIAGTEST1',
    })).toBe(false);
    expect(isOrganicClosedPaper({
      status: 'FILLED', side: 'SELL', profitLoss: 1, executionEnvironment: 'REPLAY', symbol: 'AAPL',
    })).toBe(false);
  });
});
