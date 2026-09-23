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
  const mockDb = {
    select: () => builder,
    insert: () => ({ values: () => Promise.resolve({}) }),
  };
  return { mockDb };
});

const { fakeEventBus, listeners } = vi.hoisted(() => {
  const listeners: Record<string, Array<(payload: unknown) => void>> = {};
  const fakeEventBus = {
    on: (event: string, cb: (payload: unknown) => void) => {
      (listeners[event] ||= []).push(cb);
    },
    off: (event: string, cb: (payload: unknown) => void) => {
      listeners[event] = (listeners[event] || []).filter((f) => f !== cb);
    },
    emit: (event: string, payload: unknown) => {
      for (const cb of listeners[event] || []) cb(payload);
    },
  };
  return { fakeEventBus, listeners };
});

const { ideaGenEnabled } = vi.hoisted(() => ({ ideaGenEnabled: { value: true } }));
const { evaluateSymbol, isEnabledPublic, evaluateOnDemand, technicalEvaluateOnDemand } = vi.hoisted(() => ({
  evaluateSymbol: vi.fn().mockResolvedValue({ regime: {} }),
  isEnabledPublic: vi.fn().mockReturnValue(true),
  evaluateOnDemand: vi.fn().mockResolvedValue({ status: 'forecasted' }),
  technicalEvaluateOnDemand: vi.fn().mockResolvedValue({ status: 'emitted', emitted: true }),
}));
const { fundamentalEvaluateSymbol, macroEvaluateSymbol } = vi.hoisted(() => ({
  fundamentalEvaluateSymbol: vi.fn().mockResolvedValue(undefined),
  macroEvaluateSymbol: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../db', () => ({ db: mockDb }));
vi.mock('../core/EventBus', () => ({ eventBus: fakeEventBus }));
vi.mock('../core/ideaGenerationGate', () => ({ isLiveIdeaGenerationEnabled: () => ideaGenEnabled.value }));
vi.mock('./TechnicalAgent', () => ({
  technicalAgent: { evaluateOnDemand: technicalEvaluateOnDemand },
}));
vi.mock('./QuantSignalAgent', () => ({
  quantSignalAgent: { evaluateSymbol, isEnabledPublic },
}));
vi.mock('./KronosForecastAgent', () => ({
  kronosForecastAgent: { evaluateOnDemand },
}));
vi.mock('./FundamentalAgent', () => ({
  fundamentalAgent: { evaluateSymbol: fundamentalEvaluateSymbol },
}));
vi.mock('./MacroAgent', () => ({
  macroAgent: { evaluateSymbol: macroEvaluateSymbol },
}));

import { ConfluenceCoordinator } from './ConfluenceCoordinator';
import { setPipelineAgentEnabled } from '../core/pipelineAgentGate';
import { tradingSafety } from '../config/tradingSafety';
import { CONSENSUS_APPROVAL_THRESHOLD, MIN_INDEPENDENT_AGREEING_AGENTS } from './ChiefTraderAgent';
import { getRecentCandidates, resetRecentCandidatesForTests } from '../core/recentCandidateRegistry';

function technicalIdea(overrides: Record<string, unknown> = {}) {
  return {
    traceId: 't1',
    symbol: 'AAPL',
    side: 'BUY',
    confidence: 0.8,
    agent: 'TechnicalAgent',
    reasoning: 'strong momentum',
    ...overrides,
  };
}

function kronosIdea(overrides: Record<string, unknown> = {}) {
  return { ...technicalIdea({ agent: 'KronosEngine', traceId: 'k1' }), ...overrides };
}

function quantIdea(overrides: Record<string, unknown> = {}) {
  return { ...technicalIdea({ agent: 'QuantEngine', traceId: 'q1' }), ...overrides };
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('ConfluenceCoordinator', () => {
  let coordinator: ConfluenceCoordinator;

  beforeEach(() => {
    for (const key of Object.keys(listeners)) delete listeners[key];
    evaluateSymbol.mockClear().mockResolvedValue({ regime: {} });
    isEnabledPublic.mockClear().mockReturnValue(true);
    evaluateOnDemand.mockClear().mockResolvedValue({ status: 'forecasted' });
    technicalEvaluateOnDemand.mockClear().mockResolvedValue({ status: 'emitted', emitted: true });
    ideaGenEnabled.value = true;
    setPipelineAgentEnabled('TechnicalAgent', true);
    setPipelineAgentEnabled('QuantEngine', true);
    setPipelineAgentEnabled('KronosEngine', true);
    coordinator = new ConfluenceCoordinator();
    coordinator.start();
  });

  it('existing behavior unchanged: does not touch consensus thresholds', () => {
    expect(CONSENSUS_APPROVAL_THRESHOLD).toBe(0.75);
    expect(MIN_INDEPENDENT_AGREEING_AGENTS).toBe(2);
    expect(tradingSafety.disagreementPenalty).toBe(0.5);
  });

  it('confluence increases: a qualifying TechnicalAgent BUY triggers both QuantEngine and KronosEngine on-demand (never re-triggers itself)', async () => {
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea());
    await flush();
    expect(evaluateSymbol).toHaveBeenCalledTimes(1);
    expect(evaluateOnDemand).toHaveBeenCalledTimes(1);
    expect(technicalEvaluateOnDemand).not.toHaveBeenCalled();
  });

  // 2026-09-22 symmetric-trigger fix: live evidence showed KronosEngine evaluates ~5x more often
  // than TechnicalAgent, but the OLD hardcoded `idea.agent === 'TechnicalAgent'` check meant a
  // strong Kronos-only signal never pulled in a second independent voice at all. These two tests
  // prove the fix without re-litigating independence: each on-demand call still receives only the
  // symbol (asserted below), and the triggering agent is never re-called on itself.
  it('symmetric trigger: a qualifying KronosEngine signal triggers TechnicalAgent and QuantEngine on-demand, never re-triggers KronosEngine', async () => {
    fakeEventBus.emit('TRADE_IDEA_GENERATED', kronosIdea());
    await flush();
    expect(technicalEvaluateOnDemand).toHaveBeenCalledWith('AAPL');
    expect(evaluateSymbol).toHaveBeenCalledWith('AAPL');
    expect(evaluateOnDemand).not.toHaveBeenCalled();
  });

  it('symmetric trigger: a qualifying QuantEngine signal triggers TechnicalAgent and KronosEngine on-demand, never re-triggers QuantEngine', async () => {
    fakeEventBus.emit('TRADE_IDEA_GENERATED', quantIdea());
    await flush();
    expect(technicalEvaluateOnDemand).toHaveBeenCalledWith('AAPL');
    expect(evaluateOnDemand).toHaveBeenCalledWith('AAPL');
    expect(evaluateSymbol).not.toHaveBeenCalled();
  });

  it('symmetric trigger respects per-agent Mission Control disable for TechnicalAgent too', async () => {
    setPipelineAgentEnabled('TechnicalAgent', false);
    fakeEventBus.emit('TRADE_IDEA_GENERATED', kronosIdea());
    await flush();
    expect(technicalEvaluateOnDemand).not.toHaveBeenCalled();
    expect(evaluateSymbol).toHaveBeenCalledWith('AAPL');
  });

  // 2026-09-22 (operator review of the symmetric-trigger fix): symmetric triggering opens a real
  // feedback-loop shape that didn't exist when only TechnicalAgent could trigger - a fanned-out
  // agent's own on-demand evaluation can itself emit a fresh TRADE_IDEA_GENERATED (that IS the
  // point of evaluateOnDemand), and since that agent is now ALSO trigger-eligible, the coordinator
  // would see its own fan-out's output arrive back through the same listener. This proves the
  // episode stays bounded STRUCTURALLY (the per-symbol cooldown is set synchronously at the top of
  // maybeTrigger, before any fan-out job is even created, so a re-entrant emission from a fan-out
  // job - sync or async - can never observe a clear cooldown for that symbol) rather than resting
  // on "60 seconds happens to be long enough". Guards against a future cooldown-value change
  // silently reopening this exact loop.
  it('bounded episode: a fanned-out agent emitting its own idea as a side effect of evaluateOnDemand does not cause a second fan-out for the same symbol', async () => {
    // Simulate TechnicalAgent's real evaluateOnDemand() behavior: on a real fire, it emits its own
    // TRADE_IDEA_GENERATED back onto the SAME event bus this coordinator listens on.
    technicalEvaluateOnDemand.mockImplementation(async () => {
      fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea({ traceId: 're-entrant', symbol: 'AAPL' }));
      return { status: 'emitted', emitted: true };
    });

    fakeEventBus.emit('TRADE_IDEA_GENERATED', kronosIdea()); // originating idea: KronosEngine, AAPL
    await flush();
    await flush(); // extra tick: let the re-entrant emission's own async handler fully settle too

    // One episode, one bounded fan-out: each fan-out target called exactly once, not twice, even
    // though a real TRADE_IDEA_GENERATED for AAPL from a now-trigger-eligible agent (TechnicalAgent)
    // was emitted mid-episode.
    expect(technicalEvaluateOnDemand).toHaveBeenCalledTimes(1);
    expect(evaluateSymbol).toHaveBeenCalledTimes(1); // QuantEngine - the other fan-out target
    expect(evaluateOnDemand).not.toHaveBeenCalled(); // KronosEngine - never re-triggers itself
  });

  it('Phase 9: a high-confidence (>= moderateMinConfidence) TechnicalAgent signal ALSO triggers Fundamental/MacroAgent on-demand, not just Quant/Kronos', async () => {
    fundamentalEvaluateSymbol.mockClear();
    macroEvaluateSymbol.mockClear();
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea({ confidence: tradingSafety.moderateMinConfidence }));
    await flush();
    expect(fundamentalEvaluateSymbol).toHaveBeenCalledWith('AAPL');
    expect(macroEvaluateSymbol).toHaveBeenCalledWith('AAPL');
  });

  it('Phase 9: a qualifying-but-below-moderate-confidence signal still triggers Quant/Kronos but NOT Fundamental/MacroAgent (scarce AlphaVantage budget reserved for stronger candidates)', async () => {
    fundamentalEvaluateSymbol.mockClear();
    macroEvaluateSymbol.mockClear();
    evaluateSymbol.mockClear();
    const belowModerate = Math.max(tradingSafety.confluenceCoordinatorConfidenceThreshold, tradingSafety.moderateMinConfidence - 0.05);
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea({ confidence: belowModerate }));
    await flush();
    expect(evaluateSymbol).toHaveBeenCalledTimes(1); // QuantEngine still triggered
    expect(fundamentalEvaluateSymbol).not.toHaveBeenCalled();
    expect(macroEvaluateSymbol).not.toHaveBeenCalled();
  });

  it('Phase 9 same-candidate convergence: records the triggered symbol in recentCandidateRegistry so Fundamental/MacroAgent can prioritize it', async () => {
    resetRecentCandidatesForTests();
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea({ symbol: 'NVDA' }));
    await flush();
    expect(getRecentCandidates(300000)).toContain('NVDA');
  });

  it('agents remain independent: on-demand calls receive ONLY the symbol - no side, confidence, or reasoning', async () => {
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea({ confidence: 0.93, side: 'SELL', reasoning: 'do not leak this' }));
    await flush();
    expect(evaluateSymbol).toHaveBeenCalledWith('AAPL');
    expect(evaluateOnDemand).toHaveBeenCalledWith('AAPL');
    // Single positional argument each - nothing else was passed through.
    expect(evaluateSymbol.mock.calls[0]).toHaveLength(1);
    expect(evaluateOnDemand.mock.calls[0]).toHaveLength(1);
  });

  it('symmetric trigger also stays independent: a Kronos-triggered TechnicalAgent on-demand call receives ONLY the symbol', async () => {
    fakeEventBus.emit('TRADE_IDEA_GENERATED', kronosIdea({ confidence: 0.93, side: 'SELL', reasoning: 'do not leak this' }));
    await flush();
    expect(technicalEvaluateOnDemand).toHaveBeenCalledWith('AAPL');
    expect(technicalEvaluateOnDemand.mock.calls[0]).toHaveLength(1);
  });

  it('ignores ideas from agents outside the trigger-eligible set (e.g. a paid-API-cost agent, or an unlabeled payload)', async () => {
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea({ agent: 'NewsAgent' }));
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea({ agent: undefined }));
    await flush();
    expect(evaluateSymbol).not.toHaveBeenCalled();
    expect(evaluateOnDemand).not.toHaveBeenCalled();
    expect(technicalEvaluateOnDemand).not.toHaveBeenCalled();
  });

  it('ignores HOLD ideas and below-threshold confidence', async () => {
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea({ side: 'HOLD' }));
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea({ confidence: tradingSafety.confluenceCoordinatorConfidenceThreshold - 0.01 }));
    await flush();
    expect(evaluateSymbol).not.toHaveBeenCalled();
    expect(evaluateOnDemand).not.toHaveBeenCalled();
  });

  it('no stale evidence: does nothing when live idea generation is disabled (Autobot off / paused)', async () => {
    ideaGenEnabled.value = false;
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea());
    await flush();
    expect(evaluateSymbol).not.toHaveBeenCalled();
    expect(evaluateOnDemand).not.toHaveBeenCalled();
  });

  it('ignores telemetry pulse payloads (UI-only synthetic events)', async () => {
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea({ telemetryPulse: true }));
    await flush();
    expect(evaluateSymbol).not.toHaveBeenCalled();
    expect(evaluateOnDemand).not.toHaveBeenCalled();
  });

  it('no duplicate evidence: a second qualifying idea on the same symbol within the cooldown window does not re-trigger', async () => {
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea());
    await flush();
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea({ traceId: 't2' }));
    await flush();
    expect(evaluateSymbol).toHaveBeenCalledTimes(1);
    expect(evaluateOnDemand).toHaveBeenCalledTimes(1);
  });

  it('re-triggers for a different symbol even inside another symbol\'s cooldown window', async () => {
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea({ symbol: 'AAPL' }));
    await flush();
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea({ symbol: 'MSFT', traceId: 't3' }));
    await flush();
    expect(evaluateSymbol).toHaveBeenCalledTimes(2);
    expect(evaluateOnDemand).toHaveBeenCalledTimes(2);
  });

  it('re-triggers the same symbol once the cooldown resets (test hook)', async () => {
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea());
    await flush();
    coordinator.resetCooldownForTests('AAPL');
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea({ traceId: 't4' }));
    await flush();
    expect(evaluateSymbol).toHaveBeenCalledTimes(2);
    expect(evaluateOnDemand).toHaveBeenCalledTimes(2);
  });

  it('respects per-agent Mission Control disable: a disabled QuantEngine is not called, KronosEngine still is', async () => {
    setPipelineAgentEnabled('QuantEngine', false);
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea());
    await flush();
    expect(evaluateSymbol).not.toHaveBeenCalled();
    expect(evaluateOnDemand).toHaveBeenCalledTimes(1);
  });

  it('respects QuantEngine being off by default (QUANT_ENGINE_ENABLED unset)', async () => {
    isEnabledPublic.mockReturnValue(false);
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea());
    await flush();
    expect(evaluateSymbol).not.toHaveBeenCalled();
    expect(evaluateOnDemand).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all when confluenceCoordinatorEnabled is false', async () => {
    (tradingSafety as any).confluenceCoordinatorEnabled = false;
    try {
      fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea());
      await flush();
      expect(evaluateSymbol).not.toHaveBeenCalled();
      expect(evaluateOnDemand).not.toHaveBeenCalled();
    } finally {
      (tradingSafety as any).confluenceCoordinatorEnabled = true;
    }
  });

  it('never wires NewsAgent into the on-demand trigger (real paid-API cost, no existing per-symbol hook)', async () => {
    const src = await import('node:fs/promises').then((fs) => fs.readFile(new URL('./ConfluenceCoordinator.ts', import.meta.url), 'utf8'));
    const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l));
    expect(importLines.some((l) => /NewsEngine|NewsAgent/.test(l))).toBe(false);
  });

  it('no consensus manipulation: imports neither ChiefTraderAgent, RiskEngine, OrderManagement, nor BrokerManager', async () => {
    const src = await import('node:fs/promises').then((fs) => fs.readFile(new URL('./ConfluenceCoordinator.ts', import.meta.url), 'utf8'));
    const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l));
    expect(importLines.some((l) => /ChiefTraderAgent|RiskEngine|OrderManagement|BrokerManager/.test(l))).toBe(false);
  });

  it('stop() detaches the listener - a later idea triggers nothing', async () => {
    coordinator.stop();
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea());
    await flush();
    expect(evaluateSymbol).not.toHaveBeenCalled();
    expect(evaluateOnDemand).not.toHaveBeenCalled();
  });
});
