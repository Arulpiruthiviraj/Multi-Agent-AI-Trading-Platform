import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

function qualifyingIdea(symbol: string) {
  return {
    traceId: `t_${symbol}`,
    symbol,
    side: 'BUY',
    confidence: 0.8, // >= confluenceCoordinatorConfidenceThreshold (0.5) and >= moderateMinConfidence (0.6)
    agent: 'TechnicalAgent',
    reasoning: 'strong momentum',
  };
}

/**
 * Real defect found and fixed (2026-10-08 leak hunt). ConfluenceCoordinator's `lastTriggeredAt`
 * (Map<symbol, timestamp>) was set on every trigger with NO production delete - only the test
 * hook. One entry per symbol that ever produced a qualifying signal, retained for process
 * lifetime. This proves the opportunistic sweep in maybeTrigger() actually bounds growth for a
 * large, ever-changing symbol universe, while never evicting an entry that could still enforce
 * the per-symbol cooldown (the map's only read).
 */
describe('ConfluenceCoordinator.lastTriggeredAt (real defect: no production eviction)', () => {
  let coordinator: ConfluenceCoordinator;
  const realDateNow = Date.now;
  let simulatedNow = 1_000_000_000_000;

  beforeEach(() => {
    for (const key of Object.keys(listeners)) delete listeners[key];
    evaluateSymbol.mockClear().mockResolvedValue({ regime: {} });
    isEnabledPublic.mockClear().mockReturnValue(true);
    evaluateOnDemand.mockClear().mockResolvedValue({ status: 'forecasted' });
    technicalEvaluateOnDemand.mockClear().mockResolvedValue({ status: 'emitted', emitted: true });
    fundamentalEvaluateSymbol.mockClear().mockResolvedValue(undefined);
    macroEvaluateSymbol.mockClear().mockResolvedValue(undefined);
    ideaGenEnabled.value = true;
    setPipelineAgentEnabled('TechnicalAgent', true);
    setPipelineAgentEnabled('QuantEngine', true);
    setPipelineAgentEnabled('KronosEngine', true);
    setPipelineAgentEnabled('FundamentalAgent', true);
    setPipelineAgentEnabled('MacroAgent', true);
    simulatedNow = 1_000_000_000_000;
    Date.now = () => simulatedNow;
    coordinator = new ConfluenceCoordinator();
    coordinator.start();
  });

  afterEach(() => {
    Date.now = realDateNow;
    coordinator.stop();
  });

  it('bounds Map growth: only recently-triggered symbols survive after many distinct symbols over simulated time', () => {
    const cooldownMs = tradingSafety.confluenceCoordinatorCooldownMs;
    // 500 distinct symbols, each triggering one full cooldown later than the previous - each
    // step is 2x the sweep's 10x-cooldown staleness threshold relative to earlier entries.
    for (let i = 0; i < 500; i++) {
      simulatedNow += cooldownMs * 20;
      fakeEventBus.emit('TRADE_IDEA_GENERATED', qualifyingIdea(`SYM${i}`));
    }
    const map: Map<string, number> = (coordinator as any).lastTriggeredAt;
    expect(map.size).toBeLessThan(15);
    expect(map.size).toBeGreaterThan(0);
    expect(map.has('SYM499')).toBe(true); // most recent trigger must survive
    expect(map.has('SYM0')).toBe(false); // long-stale trigger must be evicted
  });

  it('never evicts an entry that is still inside the real cooldown window (throttling stays correct)', async () => {
    fakeEventBus.emit('TRADE_IDEA_GENERATED', qualifyingIdea('AAPL'));
    await new Promise((r) => setTimeout(r, 0));
    const firstCalls = evaluateSymbol.mock.calls.length;
    expect(firstCalls).toBe(1);
    // A second qualifying signal well inside the cooldown must NOT re-trigger...
    simulatedNow += Math.floor(tradingSafety.confluenceCoordinatorCooldownMs / 2);
    fakeEventBus.emit('TRADE_IDEA_GENERATED', qualifyingIdea('AAPL'));
    await new Promise((r) => setTimeout(r, 0));
    expect(evaluateSymbol.mock.calls.length).toBe(firstCalls);
    // ...so the entry must have survived the sweep pass the second trigger ran.
    expect((coordinator as any).lastTriggeredAt.has('AAPL')).toBe(true);
  });

  it('still triggers after the cooldown expires (eviction never suppresses a legitimate trigger)', async () => {
    fakeEventBus.emit('TRADE_IDEA_GENERATED', qualifyingIdea('MSFT'));
    await new Promise((r) => setTimeout(r, 0));
    expect(evaluateSymbol).toHaveBeenCalledTimes(1);
    // Past the cooldown: the old entry may have been swept, but the trigger must fire again
    // either way (swept entry behaves exactly like a never-triggered symbol here).
    simulatedNow += tradingSafety.confluenceCoordinatorCooldownMs * 20;
    fakeEventBus.emit('TRADE_IDEA_GENERATED', qualifyingIdea('MSFT'));
    await new Promise((r) => setTimeout(r, 0));
    expect(evaluateSymbol).toHaveBeenCalledTimes(2);
  });
});
