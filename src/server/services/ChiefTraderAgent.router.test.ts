/**
 * ChiefTraderAgent policy-router tests (Quant-First Decision Architecture, Phase 7).
 *
 * Proves the router dispatch: QUANT_STRATEGY-origin ideas are authorized centrally and
 * routed to QuantExecutionPolicy / terminal reject / consensus fallback; the consensus
 * path never sees quant-routed ideas; risk exits never enter the router; AI is never
 * consulted for the quant path (hasAnyRoutableProvider=false throughout these tests).
 *
 * Uses the same safely-isolated harness as ChiefTraderAgent.test.ts (db/EventBus/AIRouter
 * mocked; authorization + policy modules mocked at the seam so these tests assert ROUTING,
 * not the policy's own internals — those are covered by QuantExecutionPolicy.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb } = vi.hoisted(() => {
  const builder: any = {
    from() { return builder; },
    where() { return builder; },
    orderBy() { return builder; },
    limit() { return builder; },
    all() { return Promise.resolve([]); },
    then(resolve: any, reject: any) { return Promise.resolve([]).then(resolve, reject); },
  };
  const insertBuilder: any = {
    values: () => ({
      run: () => undefined,
      then: (resolve: any, reject: any) => Promise.resolve({}).then(resolve, reject),
    }),
  };
  const mockDb: any = {
    select: () => builder,
    insert: () => insertBuilder,
    transaction: (cb: (tx: any) => void) => cb(mockDb),
  };
  return { mockDb };
});

const { emitChiefApproval, emit } = vi.hoisted(() => ({
  emitChiefApproval: vi.fn(),
  emit: vi.fn(),
}));
const { routeConsensus, routeTask, hasAnyRoutableProvider } = vi.hoisted(() => ({
  routeConsensus: vi.fn(),
  routeTask: vi.fn(),
  hasAnyRoutableProvider: vi.fn(),
}));
const { resolveQuantStrategyAuthorization } = vi.hoisted(() => ({
  resolveQuantStrategyAuthorization: vi.fn(),
}));
const { evaluateQuantExecutionPolicy } = vi.hoisted(() => ({
  evaluateQuantExecutionPolicy: vi.fn(),
}));

vi.mock('../db', () => ({ db: mockDb }));
vi.mock('../core/EventBus', () => ({ eventBus: { on: vi.fn(), emit, publish: vi.fn(), emitChiefApproval } }));
vi.mock('../ai/AIRouter', () => ({ AIRouter: { getInstance: () => ({ routeConsensus, routeTask, hasAnyRoutableProvider }) } }));
vi.mock('../core/ideaGenerationGate', () => ({ isLiveIdeaGenerationEnabled: () => true }));
vi.mock('../quant/QuantStrategyAuthorization', () => ({ resolveQuantStrategyAuthorization }));
vi.mock('../quant/QuantExecutionPolicy', () => ({ evaluateQuantExecutionPolicy }));

import { ChiefTraderAgent } from './ChiefTraderAgent';
import { EVENTS } from '../core/eventNames';

function authorized() {
  return {
    authority: 'AUTHORIZED_QUANT_POLICY',
    reason: 'STRATEGY_VALIDATED',
    origin: 'QUANT_STRATEGY',
    strategyId: 'MOMENTUM_BREAKOUT',
    lifecycleStatus: 'VALIDATED',
    producerAgent: 'QuantEngine',
    paperOnlyEnforced: true,
    checkedAt: new Date().toISOString(),
  };
}

function approvedDecision() {
  return {
    approved: true,
    decisionPolicy: 'QUANT_EXECUTION',
    reasonCode: 'QUANT_POLICY_APPROVED',
    reason: 'policy approved',
    authorization: authorized(),
    checks: [],
    supportSatisfied: 3,
    supportRequired: 2,
    riskRewardRatio: 2.0,
    strategyConfidence: 0.8,
    consensusConfidence: null,
    aiAvailability: 'NOT_CONSULTED',
    aiAdvisoryNote: null,
    evaluatedAt: new Date().toISOString(),
    durationMs: 5,
  };
}

function quantIdea(overrides: Record<string, unknown> = {}) {
  return {
    traceId: 'tq1',
    symbol: 'AAPL',
    side: 'BUY',
    confidence: 0.8,
    reasoning: 'breakout',
    agent: 'QuantEngine',
    currentPrice: 100,
    origin: 'QUANT_STRATEGY',
    strategyId: 'MOMENTUM_BREAKOUT',
    ...overrides,
  };
}

describe('ChiefTraderAgent policy router', () => {
  let agent: any;

  beforeEach(() => {
    emitChiefApproval.mockClear();
    emit.mockClear();
    routeConsensus.mockReset();
    routeTask.mockReset();
    // AI is DOWN for every test here: the quant path must not need it.
    hasAnyRoutableProvider.mockReset().mockResolvedValue(false);
    resolveQuantStrategyAuthorization.mockReset();
    evaluateQuantExecutionPolicy.mockReset();
    agent = new ChiefTraderAgent();
    agent.recentIdeas = [];
  });

  it('routes an authorized quant idea to the policy and emits canonical approval with AI down', async () => {
    resolveQuantStrategyAuthorization.mockResolvedValue(authorized());
    evaluateQuantExecutionPolicy.mockResolvedValue(approvedDecision());

    await agent.reviewIdea(quantIdea());

    expect(resolveQuantStrategyAuthorization).toHaveBeenCalledTimes(1);
    expect(evaluateQuantExecutionPolicy).toHaveBeenCalledTimes(1);
    // AI was never consulted for the decision (only a routability snapshot for observability).
    expect(routeConsensus).not.toHaveBeenCalled();
    expect(routeTask).not.toHaveBeenCalled();
    // Canonical approval: same CHIEF_APPROVED_IDEA event the consensus path emits.
    expect(emitChiefApproval).toHaveBeenCalledTimes(1);
    const approval = emitChiefApproval.mock.calls[0][0];
    expect(approval.decisionPolicy).toBe('QUANT_EXECUTION');
    expect(approval.consensusConfidence).toBeNull();
    expect(approval.strategyId).toBe('MOMENTUM_BREAKOUT');
    expect(approval.side).toBe('BUY');
    expect(approval.transactionId).toMatch(/^ARG-/);
    // The idea never entered the consensus evidence pool.
    expect(agent.recentIdeas).toEqual([]);
  });

  it('a policy rejection is terminal: no approval, precise quant reason, never re-routed to consensus', async () => {
    resolveQuantStrategyAuthorization.mockResolvedValue(authorized());
    evaluateQuantExecutionPolicy.mockResolvedValue({
      ...approvedDecision(),
      approved: false,
      reasonCode: 'QUANT_TRIGGER_NOT_FIRED',
      reason: 'trigger did not fire',
    });

    await agent.reviewIdea(quantIdea());

    expect(emitChiefApproval).not.toHaveBeenCalled();
    const noTrade = emit.mock.calls.find((c: any[]) => c[0] === EVENTS.DESK_NO_TRADE);
    expect(noTrade).toBeTruthy();
    expect(noTrade[1].quantReasonCode).toBe('QUANT_TRIGGER_NOT_FIRED');
    expect(noTrade[1].terminalReasonCode).toBe('QUANT_POLICY_REJECTED');
    expect(noTrade[1].decisionPolicy).toBe('QUANT_EXECUTION');
    // Not silently re-routed: the consensus pool is empty and no consensus ran.
    expect(agent.recentIdeas).toEqual([]);
  });

  it('NOT_ELIGIBLE (e.g. retired strategy) is terminally rejected without consensus', async () => {
    resolveQuantStrategyAuthorization.mockResolvedValue({
      ...authorized(),
      authority: 'NOT_ELIGIBLE',
      reason: 'STRATEGY_RETIRED',
      lifecycleStatus: 'RETIRED',
    });

    await agent.reviewIdea(quantIdea());

    expect(evaluateQuantExecutionPolicy).not.toHaveBeenCalled();
    expect(emitChiefApproval).not.toHaveBeenCalled();
    const noTrade = emit.mock.calls.find((c: any[]) => c[0] === EVENTS.DESK_NO_TRADE);
    expect(noTrade).toBeTruthy();
    expect(noTrade[1].terminalReasonCode).toBe('QUANT_NOT_AUTHORIZED');
    expect(noTrade[1].quantReasonCode).toBe('STRATEGY_RETIRED');
  });

  it('NOT_AUTHORIZED (missing lifecycle record) is terminal: dropped, never re-routed to consensus', async () => {
    // Defect #1 (2026-10-08): missing state fails closed. The idea is terminally rejected —
    // it must not silently inherit consensus-path behavior, and the missing record must be
    // visible in the DESK_NO_TRADE event for operator follow-up.
    resolveQuantStrategyAuthorization.mockResolvedValue({
      ...authorized(),
      authority: 'NOT_AUTHORIZED',
      reason: 'NO_LIFECYCLE_RECORD',
      lifecycleStatus: null,
    });

    await agent.reviewIdea(quantIdea());

    expect(evaluateQuantExecutionPolicy).not.toHaveBeenCalled();
    expect(emitChiefApproval).not.toHaveBeenCalled();
    const noTrade = emit.mock.calls.find((c: any[]) => c[0] === EVENTS.DESK_NO_TRADE);
    expect(noTrade).toBeTruthy();
    expect(noTrade[1].terminalReasonCode).toBe('QUANT_NOT_AUTHORIZED');
    expect(noTrade[1].quantReasonCode).toBe('NO_LIFECYCLE_RECORD');
    expect(noTrade[1].reason).toContain('NO_LIFECYCLE_RECORD');
    // Not silently re-routed: the consensus pool is empty and no consensus ran.
    expect(agent.recentIdeas).toEqual([]);
  });

  it('paper-only lock disengaged (ENVIRONMENT_NOT_AUTHORIZED) never routes to the policy and never approves', async () => {
    // Part-30 (Workstream F, 2026-10-08): the exact authorization shape the real
    // resolver returns when PAPER_TRADING_ONLY is not engaged. The router must treat
    // it as terminal — no policy evaluation, no chief approval, no consensus fallback.
    resolveQuantStrategyAuthorization.mockResolvedValue({
      ...authorized(),
      authority: 'NOT_ELIGIBLE',
      reason: 'ENVIRONMENT_NOT_AUTHORIZED',
      lifecycleStatus: null,
      paperOnlyEnforced: false,
    });

    await agent.reviewIdea(quantIdea());

    expect(evaluateQuantExecutionPolicy).not.toHaveBeenCalled();
    expect(emitChiefApproval).not.toHaveBeenCalled();
    const noTrade = emit.mock.calls.find((c: any[]) => c[0] === EVENTS.DESK_NO_TRADE);
    expect(noTrade).toBeTruthy();
    expect(noTrade[1].terminalReasonCode).toBe('QUANT_NOT_AUTHORIZED');
    expect(noTrade[1].quantReasonCode).toBe('ENVIRONMENT_NOT_AUTHORIZED');
    // Terminal: not silently re-routed into the consensus pool either.
    expect(agent.recentIdeas).toEqual([]);
  });

  it('REQUIRES_CONSENSUS falls through to the unchanged consensus path', async () => {
    resolveQuantStrategyAuthorization.mockResolvedValue({
      ...authorized(),
      authority: 'REQUIRES_CONSENSUS',
      reason: 'STRATEGY_UNTESTED',
      lifecycleStatus: 'UNTESTED',
    });

    await agent.reviewIdea(quantIdea());

    expect(evaluateQuantExecutionPolicy).not.toHaveBeenCalled();
    // Normal intake: upserted into the evidence pool for consensus (single voice → no approval).
    expect(agent.recentIdeas.length).toBe(1);
    expect(emitChiefApproval).not.toHaveBeenCalled();
  });

  it('non-quant origins never consult the authorization resolver', async () => {
    await agent.reviewIdea({ ...quantIdea(), origin: 'TECHNICAL', agent: 'TechnicalAgent', strategyId: undefined });

    expect(resolveQuantStrategyAuthorization).not.toHaveBeenCalled();
    expect(evaluateQuantExecutionPolicy).not.toHaveBeenCalled();
    expect(agent.recentIdeas.length).toBe(1);
  });

  it('a risk exit never enters the quant router even if mis-tagged QUANT_STRATEGY', async () => {
    await agent.reviewIdea({
      traceId: 'tx1',
      symbol: 'AAPL',
      side: 'SELL',
      confidence: 0.9,
      reasoning: 'EXIT_CODE=STOP',
      agent: 'PortfolioManager',
      currentPrice: 95,
      origin: 'QUANT_STRATEGY',
    });

    expect(resolveQuantStrategyAuthorization).not.toHaveBeenCalled();
    expect(evaluateQuantExecutionPolicy).not.toHaveBeenCalled();
    // Risk-exit path: force-immediate consensus evaluation, not the policy.
    expect(agent.recentIdeas.length).toBe(1);
  });

  it('a policy throw fails closed instead of breaking the router', async () => {
    resolveQuantStrategyAuthorization.mockResolvedValue(authorized());
    evaluateQuantExecutionPolicy.mockRejectedValue(new Error('boom'));

    await agent.reviewIdea(quantIdea());

    expect(emitChiefApproval).not.toHaveBeenCalled();
    const noTrade = emit.mock.calls.find((c: any[]) => c[0] === EVENTS.DESK_NO_TRADE);
    expect(noTrade).toBeTruthy();
    expect(noTrade[1].quantReasonCode).toBe('QUANT_POLICY_ERROR');
  });

  it('AI-on parity: with providers available, the quant path still never consults AI', async () => {
    // AI is UP for this test only — the quant path must remain AI-free regardless.
    hasAnyRoutableProvider.mockResolvedValue(true);
    routeConsensus.mockResolvedValue({ action: 'TRADE', confidence: 0.9, reasoning: 'ai' } as any);
    resolveQuantStrategyAuthorization.mockResolvedValue(authorized());
    evaluateQuantExecutionPolicy.mockResolvedValue(approvedDecision());

    await agent.reviewIdea(quantIdea());

    expect(routeConsensus).not.toHaveBeenCalled();
    expect(routeTask).not.toHaveBeenCalled();
    expect(emitChiefApproval).toHaveBeenCalledTimes(1);
    expect(emitChiefApproval.mock.calls[0][0].decisionPolicy).toBe('QUANT_EXECUTION');
  });
});
