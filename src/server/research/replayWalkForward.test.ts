import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// Real gap found and fixed (Phase 16, 2026-09-01): experimentLedger.ts's real trial-counting /
// multiple-testing-warning / Deflated Sharpe Ratio infrastructure existed but nothing in this
// walk-forward path ever called recordExperimentTrial() - a full multi-strategy matrix run was
// structurally invisible to that existing protection. These tests mock FullArgusReplayEngine (a
// real replay run is slow/network-dependent) to prove the orchestration wiring itself: one real
// experimentLedger trial per (strategy, fold), including strategies with zero closed trades.
vi.mock('../replay/FullArgusReplayEngine', () => ({
  createReplayRun: vi.fn(async () => ({ replayId: 'fake-replay-1', status: 'READY', datasetHash: 'sha256:fake-dataset-hash' })),
  startReplay: vi.fn(async () => ({ replayId: 'fake-replay-1', status: 'COMPLETED', datasetHash: 'sha256:fake-dataset-hash' })),
  getReplayTrades: vi.fn(() => [
    { timestamp: Date.parse('2026-02-01T00:00:00.000Z'), symbol: 'AAPL', side: 'SELL', quantity: 1, price: 100, strategyId: 'MOMENTUM_BREAKOUT', traceId: 't1', realizedPnl: 50, executionEnvironment: 'REPLAY' },
  ]),
}));

describe('runReplayWalkForward - experimentLedger integration', () => {
  beforeEach(async () => {
    const { resetExperimentLedgerForTests } = await import('./experimentLedger');
    resetExperimentLedgerForTests();
  });

  it('records one real experimentLedger trial per (strategy, fold), including strategies with zero closed trades in that fold', async () => {
    const { runReplayWalkForward } = await import('./replayWalkForward');
    const { experimentLedgerSnapshot, experimentAuditTrail } = await import('./experimentLedger');

    await runReplayWalkForward({
      symbols: ['AAPL'],
      strategyIds: ['MOMENTUM_BREAKOUT', 'MEAN_REVERSION'],
      startDate: '2026-02-01',
      endDate: '2026-02-28',
      foldCount: 1,
    });

    const snapshot = experimentLedgerSnapshot();
    expect(snapshot.trials).toBe(2); // both requested strategies get a trial this fold, even MEAN_REVERSION with zero trades
    expect(snapshot.byStrategy.MOMENTUM_BREAKOUT).toBe(1);
    expect(snapshot.byStrategy.MEAN_REVERSION).toBe(1);

    const mbTrials = experimentAuditTrail('MOMENTUM_BREAKOUT');
    expect(mbTrials).toHaveLength(1);
    expect(mbTrials[0].datasetHash).toBe('sha256:fake-dataset-hash');
    expect((mbTrials[0].outOfSampleMetrics as any).closedTrades).toBe(1);
    expect((mbTrials[0].outOfSampleMetrics as any).netPnl).toBe(50);

    const mrTrials = experimentAuditTrail('MEAN_REVERSION');
    expect(mrTrials).toHaveLength(1);
    expect((mrTrials[0].outOfSampleMetrics as any).closedTrades).toBe(0);
  });
});
