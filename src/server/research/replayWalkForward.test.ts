import { describe, it, expect } from 'vitest';
import { summarizeWalkForwardConsistency, type ReplayFoldResult } from './replayWalkForward';

function makeFold(foldIndex: number, strategyStats: ReplayFoldResult['strategyStats']): ReplayFoldResult {
  return { foldIndex, fromDate: `2026-0${foldIndex + 1}-01`, toDate: `2026-0${foldIndex + 1}-28`, replayId: `fake-${foldIndex}`, status: 'COMPLETED', strategyStats };
}

describe('summarizeWalkForwardConsistency', () => {
  it('reports NO_EVIDENCE (not silent omission) for a requested strategy with zero real closed round-trips across every fold', () => {
    const folds: ReplayFoldResult[] = [makeFold(0, {}), makeFold(1, {})];
    const verdicts = summarizeWalkForwardConsistency(folds, 5, ['NEVER_TRADED']);
    const v = verdicts.find((v) => v.strategyId === 'NEVER_TRADED')!;
    expect(v).toBeDefined();
    expect(v.status).toBe('NO_EVIDENCE');
    expect(v.totalClosedTrades).toBe(0);
  });

  it('reports INSUFFICIENT_SAMPLE when fewer than 2 folds have enough closed trades to judge', () => {
    const folds: ReplayFoldResult[] = [
      makeFold(0, { SPARSE_STRATEGY: { closedTrades: 2, wins: 2, losses: 0, netPnl: 20 } }),
      makeFold(1, { SPARSE_STRATEGY: { closedTrades: 1, wins: 0, losses: 1, netPnl: -10 } }),
    ];
    const verdicts = summarizeWalkForwardConsistency(folds, 5);
    const v = verdicts.find((v) => v.strategyId === 'SPARSE_STRATEGY')!;
    expect(v.status).toBe('INSUFFICIENT_SAMPLE');
  });

  it('reports CONSISTENT_ABOVE_CHANCE when every judgeable fold clears chance', () => {
    const folds: ReplayFoldResult[] = [
      makeFold(0, { GOOD_STRATEGY: { closedTrades: 20, wins: 16, losses: 4, netPnl: 500 } }),
      makeFold(1, { GOOD_STRATEGY: { closedTrades: 20, wins: 15, losses: 5, netPnl: 420 } }),
      makeFold(2, { GOOD_STRATEGY: { closedTrades: 20, wins: 17, losses: 3, netPnl: 600 } }),
    ];
    const verdicts = summarizeWalkForwardConsistency(folds, 5);
    const v = verdicts.find((v) => v.strategyId === 'GOOD_STRATEGY')!;
    expect(v.status).toBe('CONSISTENT_ABOVE_CHANCE');
    expect(v.totalClosedTrades).toBe(60);
    expect(v.totalNetPnl).toBeCloseTo(1520, 2);
  });

  it('reports CONSISTENT_BELOW_CHANCE when every judgeable fold sits at or below chance - matches the real PULLBACK_CONTINUATION pattern', () => {
    const folds: ReplayFoldResult[] = [
      makeFold(0, { BAD_STRATEGY: { closedTrades: 20, wins: 4, losses: 16, netPnl: -400 } }),
      makeFold(1, { BAD_STRATEGY: { closedTrades: 20, wins: 5, losses: 15, netPnl: -350 } }),
    ];
    const verdicts = summarizeWalkForwardConsistency(folds, 5);
    const v = verdicts.find((v) => v.strategyId === 'BAD_STRATEGY')!;
    expect(v.status).toBe('CONSISTENT_BELOW_CHANCE');
  });

  it('reports INCONSISTENT when folds disagree on which side of chance they sit - never claims a stable edge from a regime-dependent result', () => {
    const folds: ReplayFoldResult[] = [
      makeFold(0, { FLIPPING_STRATEGY: { closedTrades: 20, wins: 17, losses: 3, netPnl: 500 } }),
      makeFold(1, { FLIPPING_STRATEGY: { closedTrades: 20, wins: 3, losses: 17, netPnl: -500 } }),
    ];
    const verdicts = summarizeWalkForwardConsistency(folds, 5);
    const v = verdicts.find((v) => v.strategyId === 'FLIPPING_STRATEGY')!;
    expect(v.status).toBe('INCONSISTENT');
  });

  it('never mixes one strategy\'s trades into another\'s verdict', () => {
    const folds: ReplayFoldResult[] = [
      makeFold(0, {
        STRATEGY_A: { closedTrades: 20, wins: 18, losses: 2, netPnl: 800 },
        STRATEGY_B: { closedTrades: 20, wins: 2, losses: 18, netPnl: -800 },
      }),
      makeFold(1, {
        STRATEGY_A: { closedTrades: 20, wins: 17, losses: 3, netPnl: 700 },
        STRATEGY_B: { closedTrades: 20, wins: 3, losses: 17, netPnl: -700 },
      }),
    ];
    const verdicts = summarizeWalkForwardConsistency(folds, 5);
    expect(verdicts.find((v) => v.strategyId === 'STRATEGY_A')!.status).toBe('CONSISTENT_ABOVE_CHANCE');
    expect(verdicts.find((v) => v.strategyId === 'STRATEGY_B')!.status).toBe('CONSISTENT_BELOW_CHANCE');
  });
});
