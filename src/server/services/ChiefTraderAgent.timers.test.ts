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

vi.mock('../db', () => ({ db: mockDb }));
vi.mock('../core/EventBus', () => ({ eventBus: { on: vi.fn(), emit: vi.fn(), publish: vi.fn(), emitChiefApproval: vi.fn() } }));
vi.mock('../ai/AIRouter', () => ({ AIRouter: { getInstance: () => ({ routeConsensus: vi.fn(), routeTask: vi.fn(), hasAnyRoutableProvider: vi.fn() }) } }));
vi.mock('../core/ideaGenerationGate', () => ({ isLiveIdeaGenerationEnabled: () => true }));

import { ChiefTraderAgent } from './ChiefTraderAgent';

/**
 * DEF-3 regression: ChiefTraderAgent's two constructor timers (idea-TTL sweep and weight sync)
 * were previously un-stoppable - the setInterval return values were discarded, so the timers
 * ticked forever, including during the graceful-shutdown drain where a tick landing between
 * sqliteDb.close() and process.exit() threw "database connection is not open" noise.
 * stop() must clear both timers.
 */
describe('ChiefTraderAgent constructor timers are stoppable (DEF-3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers exactly two interval timers at construction', () => {
    const agent = new ChiefTraderAgent() as any;
    expect(vi.getTimerCount()).toBe(2);
    expect(agent.ideaTtlSweepTimer).not.toBeNull();
    expect(agent.weightSyncTimer).not.toBeNull();
    agent.stop();
  });

  it('stop() clears both timers so no tick can fire afterwards', () => {
    const agent = new ChiefTraderAgent() as any;
    expect(vi.getTimerCount()).toBe(2);
    agent.stop();
    expect(agent.ideaTtlSweepTimer).toBeNull();
    expect(agent.weightSyncTimer).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    // Advancing far past both cadences must not throw or touch the (mocked) db.
    expect(() => vi.advanceTimersByTime(10 * 60 * 1000)).not.toThrow();
  });

  it('stop() is idempotent - calling it twice does not throw', () => {
    const agent = new ChiefTraderAgent() as any;
    agent.stop();
    expect(() => agent.stop()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
