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
const { evaluateSymbol, isEnabledPublic, evaluateOnDemand } = vi.hoisted(() => ({
  evaluateSymbol: vi.fn().mockResolvedValue({ regime: {} }),
  isEnabledPublic: vi.fn().mockReturnValue(true),
  evaluateOnDemand: vi.fn().mockResolvedValue({ status: 'forecasted' }),
}));

vi.mock('../db', () => ({ db: mockDb }));
vi.mock('../core/EventBus', () => ({ eventBus: fakeEventBus }));
vi.mock('../core/ideaGenerationGate', () => ({ isLiveIdeaGenerationEnabled: () => ideaGenEnabled.value }));
vi.mock('./QuantSignalAgent', () => ({
  quantSignalAgent: { evaluateSymbol, isEnabledPublic },
}));
vi.mock('./KronosForecastAgent', () => ({
  kronosForecastAgent: { evaluateOnDemand },
}));

import { ConfluenceCoordinator } from './ConfluenceCoordinator';
import { setPipelineAgentEnabled } from '../core/pipelineAgentGate';
import { tradingSafety } from '../config/tradingSafety';
import { CONSENSUS_APPROVAL_THRESHOLD, MIN_INDEPENDENT_AGREEING_AGENTS } from './ChiefTraderAgent';

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
    ideaGenEnabled.value = true;
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

  it('confluence increases: a qualifying TechnicalAgent BUY triggers both QuantEngine and KronosEngine on-demand', async () => {
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea());
    await flush();
    expect(evaluateSymbol).toHaveBeenCalledTimes(1);
    expect(evaluateOnDemand).toHaveBeenCalledTimes(1);
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

  it('ignores ideas from any agent other than TechnicalAgent', async () => {
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea({ agent: 'QuantEngine' }));
    await flush();
    expect(evaluateSymbol).not.toHaveBeenCalled();
    expect(evaluateOnDemand).not.toHaveBeenCalled();
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
