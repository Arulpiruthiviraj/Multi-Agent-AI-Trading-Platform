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

describe('ConfluenceCoordinator on-demand Quant in-flight guard (Oct-12 live forensic)', () => {
  let coordinator: ConfluenceCoordinator;

  beforeEach(() => {
    for (const key of Object.keys(listeners)) delete listeners[key];
    evaluateSymbol.mockReset();
    isEnabledPublic.mockReset().mockReturnValue(true);
    evaluateOnDemand.mockClear().mockResolvedValue({ status: 'forecasted' });
    technicalEvaluateOnDemand.mockClear().mockResolvedValue({ status: 'emitted', emitted: true });
    ideaGenEnabled.value = true;
    setPipelineAgentEnabled('TechnicalAgent', true);
    setPipelineAgentEnabled('QuantEngine', true);
    setPipelineAgentEnabled('KronosEngine', true);
    coordinator = new ConfluenceCoordinator();
    coordinator.start();
  });

  it('does not start a second evaluateSymbol for a symbol whose previous on-demand evaluation is still running (cooldown elapsed)', async () => {
    // Live finding: evaluations took ~300 s while the per-symbol cooldown is 60 s, so repeated
    // triggers stacked ~5 overlapping evaluations per symbol (220-400 in flight, 3,035 on-demand).
    let release!: () => void;
    evaluateSymbol.mockImplementation(() => new Promise<void>((r) => { release = r; }));
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea());
    await flush();
    expect(evaluateSymbol).toHaveBeenCalledTimes(1);

    coordinator.resetCooldownForTests('AAPL'); // cooldown elapsed, evaluation still running
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea({ traceId: 't2' }));
    await flush();
    expect(evaluateSymbol).toHaveBeenCalledTimes(1);

    release();
    await flush();
  });

  it('allows a new evaluation once the previous one settles - success', async () => {
    evaluateSymbol.mockResolvedValue({ regime: {} });
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea());
    await flush();
    coordinator.resetCooldownForTests('AAPL');
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea({ traceId: 't2' }));
    await flush();
    expect(evaluateSymbol).toHaveBeenCalledTimes(2);
  });

  it('allows a new evaluation once the previous one settles - rejection releases the guard (no leaked slot)', async () => {
    evaluateSymbol.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ regime: {} });
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea());
    await flush();
    coordinator.resetCooldownForTests('AAPL');
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea({ traceId: 't2' }));
    await flush();
    expect(evaluateSymbol).toHaveBeenCalledTimes(2);
  });

  it('guard is per symbol: a different symbol still evaluates while AAPL is in flight', async () => {
    evaluateSymbol.mockImplementation(() => new Promise<void>(() => { /* never settles */ }));
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea());
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea({ symbol: 'MSFT', traceId: 't3' }));
    await flush();
    expect(evaluateSymbol).toHaveBeenCalledTimes(2);
    expect(evaluateSymbol).toHaveBeenCalledWith('AAPL');
    expect(evaluateSymbol).toHaveBeenCalledWith('MSFT');
  });

  it('does not alter other on-demand agents: Kronos still triggers while Quant is in flight', async () => {
    evaluateSymbol.mockImplementation(() => new Promise<void>(() => { /* never settles */ }));
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea());
    await flush();
    coordinator.resetCooldownForTests('AAPL');
    fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea({ traceId: 't2' }));
    await flush();
    expect(evaluateOnDemand).toHaveBeenCalledTimes(2);
  });

  it('a never-settling evaluation stops blocking its symbol after quantOnDemandInflightMaxAgeMs (bounded replacement)', async () => {
    const realNow = Date.now;
    let clock = realNow.call(Date);
    Date.now = () => clock;
    try {
      evaluateSymbol.mockImplementation(() => new Promise<void>(() => { /* never settles */ }));
      fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea());
      await flush();
      expect(evaluateSymbol).toHaveBeenCalledTimes(1);

      clock += tradingSafety.quantOnDemandInflightMaxAgeMs - 1;
      coordinator.resetCooldownForTests('AAPL');
      fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea({ traceId: 't2' }));
      await flush();
      expect(evaluateSymbol).toHaveBeenCalledTimes(1); // still younger than the bound

      clock += 2;
      coordinator.resetCooldownForTests('AAPL');
      fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea({ traceId: 't3' }));
      await flush();
      expect(evaluateSymbol).toHaveBeenCalledTimes(2); // exactly one replacement

      coordinator.resetCooldownForTests('AAPL');
      fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea({ traceId: 't4' }));
      await flush();
      expect(evaluateSymbol).toHaveBeenCalledTimes(2); // replacement is itself guarded
    } finally {
      Date.now = realNow;
    }
  });

  it('a stale evaluation settling late does not release the replacement evaluation slot', async () => {
    const realNow = Date.now;
    let clock = realNow.call(Date);
    Date.now = () => clock;
    try {
      const releases: Array<() => void> = [];
      evaluateSymbol.mockImplementation(() => new Promise<void>((r) => { releases.push(r); }));
      fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea());
      await flush();
      clock += tradingSafety.quantOnDemandInflightMaxAgeMs + 1;
      coordinator.resetCooldownForTests('AAPL');
      fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea({ traceId: 't2' }));
      await flush();
      expect(evaluateSymbol).toHaveBeenCalledTimes(2);

      releases[0](); // the OLD one finally settles
      await flush();
      coordinator.resetCooldownForTests('AAPL');
      fakeEventBus.emit('TRADE_IDEA_GENERATED', technicalIdea({ traceId: 't3' }));
      await flush();
      expect(evaluateSymbol).toHaveBeenCalledTimes(2); // replacement still owns the slot
    } finally {
      Date.now = realNow;
    }
  });
});

