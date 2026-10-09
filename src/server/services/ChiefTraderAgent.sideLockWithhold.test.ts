import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEmit, mockDbBuilder } = vi.hoisted(() => {
  const builder: any = {
    from() { return builder; },
    where() { return builder; },
    orderBy() { return builder; },
    limit() { return builder; },
    all() { return Promise.resolve([]); },
    then(resolve: any, reject: any) { return Promise.resolve([]).then(resolve, reject); },
  };
  return {
    mockEmit: vi.fn(),
    mockDbBuilder: builder,
  };
});

vi.mock('../db', () => ({
  db: {
    select: () => mockDbBuilder,
    insert: () => ({ values: () => Promise.resolve({}) }),
  },
  dbPath: 'test.db',
  sqliteDb: { close: vi.fn() },
}));
vi.mock('../core/EventBus', () => ({
  eventBus: { on: vi.fn(), emit: mockEmit, publish: vi.fn(), emitChiefApproval: vi.fn() },
}));
vi.mock('../ai/AIRouter', () => ({
  AIRouter: { getInstance: () => ({ routeConsensus: vi.fn(), routeTask: vi.fn(), hasAnyRoutableProvider: vi.fn(async () => false) }) },
}));
vi.mock('../quant/QuantExecutionPolicy', () => ({
  evaluateQuantExecutionPolicy: vi.fn(),
}));

import { EVENTS } from '../core/eventNames';
import { ChiefTraderAgent } from './ChiefTraderAgent';
import { evaluateQuantExecutionPolicy } from '../quant/QuantExecutionPolicy';
import { deriveMappedCategory } from '../observability/whyNoTradeReport';

/**
 * Real defects found and fixed (2026-10-08 defect hunt, core reader F1/F2):
 *
 * F1: when an operator CONFIRM side-lock withheld a quant-policy approval, the
 * branch emitted only TRADE_REJECTED_CONSENSUS + TRADE_LIFECYCLE(NO_TRADE):
 *   - no DESK_NO_TRADE (so the why-no-trade taxonomy had no record of the veto),
 *   - no CHIEF_CONSENSUS_COMPLETED (so manualTradeCoEvaluation's waitForConsensusCompleted
 *     hung to full timeout instead of resolving with the mismatch reason),
 *   - lastConsensusOutcome kept approved=true (consumers like DiagnosticService
 *     reported an approval that never happened).
 * F2: the consensus-path side-mismatch labeled the veto AGENT_HOLD, misattributing an
 * operator veto as a consensus failure. Both now use MANUAL_SIDE_MISMATCH.
 */
describe('ChiefTraderAgent operator side-lock withholding (real defects F1/F2)', () => {
  beforeEach(() => {
    mockEmit.mockClear();
    vi.mocked(evaluateQuantExecutionPolicy).mockReset();
  });

  function makeAgent(): any {
    return new ChiefTraderAgent();
  }

  function approvedDecision() {
    return {
      approved: true,
      decisionPolicy: 'QUANT_EXECUTION' as const,
      reasonCode: 'QUANT_POLICY_APPROVED' as const,
      reason: 'policy approved',
      authorization: { strategyId: 's1', lifecycleStatus: 'VALIDATED', origin: 'QUANT_STRATEGY', reason: 'ok' },
      checks: [],
      supportSatisfied: 3,
      supportRequired: 2,
      riskRewardRatio: 2.1,
      strategyConfidence: 0.8,
      consensusConfidence: null,
      aiAvailability: 'NOT_CONSULTED',
      aiAdvisoryNote: null,
      evaluatedAt: new Date().toISOString(),
      durationMs: 1,
    };
  }

  it('quant side-lock withholding emits DESK_NO_TRADE + CHIEF_CONSENSUS_COMPLETED and corrects lastConsensusOutcome', async () => {
    vi.mocked(evaluateQuantExecutionPolicy).mockResolvedValue(approvedDecision() as any);
    const agent = makeAgent();
    try {
      // Operator CONFIRMed SELL; the policy approved BUY -> withhold.
      agent.registerManualSideExpectation('NVDA', 'SELL', 60000);
      await agent.evaluateQuantPolicy(
        { traceId: 't1', symbol: 'NVDA', side: 'BUY', confidence: 0.8, reasoning: 'r', agent: 'QuantEngine' },
        { strategyId: 's1', lifecycleStatus: 'VALIDATED', origin: 'QUANT_STRATEGY', reason: 'ok' } as any,
      );

      const emitted = mockEmit.mock.calls.map((c) => c[0]);
      expect(emitted).toContain(EVENTS.DESK_NO_TRADE);
      expect(emitted).toContain(EVENTS.CHIEF_CONSENSUS_COMPLETED);

      const deskNoTrade = mockEmit.mock.calls.find((c) => c[0] === EVENTS.DESK_NO_TRADE)![1];
      expect(deskNoTrade.terminalReasonCode).toBe('MANUAL_SIDE_MISMATCH');

      const completed = mockEmit.mock.calls.find((c) => c[0] === EVENTS.CHIEF_CONSENSUS_COMPLETED)![1];
      expect(completed.approved).toBe(false);
      expect(completed.terminalReasonCode).toBe('MANUAL_SIDE_MISMATCH');

      // lastConsensusOutcome must not report an approval that was withheld.
      expect(agent.lastConsensusOutcome.approved).toBe(false);
      expect(agent.lastConsensusOutcome.terminalReasonCode).toBe('MANUAL_SIDE_MISMATCH');

      // No approval may leak downstream.
      expect(emitted).not.toContain(EVENTS.CHIEF_APPROVED_IDEA);
    } finally {
      agent.stop();
    }
  });

  it('why-no-trade taxonomy attributes an operator veto as OPERATOR_SIDE_LOCK_VETO, not CONSENSUS_INSUFFICIENT', () => {
    const base = {
      tradingState: 'TRADING_ENABLED' as const,
      brokerReady: true,
      quant: { found: false } as any,
      consensusFound: true,
      riskReached: false,
      riskApproved: null,
    };
    expect(deriveMappedCategory({ ...base, terminalReasonCode: 'MANUAL_SIDE_MISMATCH', primaryPath: 'CONSENSUS' }))
      .toBe('OPERATOR_SIDE_LOCK_VETO');
    expect(deriveMappedCategory({ ...base, terminalReasonCode: 'AGENT_HOLD', primaryPath: 'CONSENSUS' }))
      .toBe('CONSENSUS_INSUFFICIENT');
  });
});
