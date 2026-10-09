import { describe, it, expect, vi } from 'vitest';

const { mockDb } = vi.hoisted(() => {
  const builder: any = {
    from() { return builder; },
    where() { return builder; },
    orderBy() { return builder; },
    limit() { return builder; },
    all() { return Promise.resolve([]); },
    then(resolve: any, reject: any) { return Promise.resolve([]).then(resolve, reject); },
  };
  return { mockDb: { select: () => builder, insert: () => ({ values: () => Promise.resolve({}) }) } };
});

vi.mock('../db', () => ({ db: mockDb, dbPath: 'test.db', sqliteDb: { close: vi.fn() } }));
vi.mock('../core/EventBus', () => ({ eventBus: { on: vi.fn(), emit: vi.fn(), publish: vi.fn(), emitChiefApproval: vi.fn() } }));
vi.mock('../ai/AIRouter', () => ({ AIRouter: { getInstance: () => ({ routeConsensus: vi.fn(), routeTask: vi.fn(), hasAnyRoutableProvider: vi.fn() }) } }));

import { ChiefTraderAgent } from './ChiefTraderAgent';

/**
 * Real defect found and fixed (2026-10-08 leak hunt). `manualSideExpectations` (Map<symbol,
 * {side, expiresAt}>) was only deleted inside consumeManualSideMismatch() - an operator CONFIRM
 * for a symbol that was never evaluated again pinned its entry past expiry for process
 * lifetime. Expired entries are dead by definition (consumeManualSideMismatch deletes them on
 * read), so registerManualSideExpectation()'s opportunistic sweep is behavior-preserving.
 */
describe('ChiefTraderAgent.registerManualSideExpectation (real defect: expired entries never swept)', () => {
  it('evicts expired entries when a new expectation is registered, keeps the new one', () => {
    const agent = new ChiefTraderAgent() as any;
    let simulatedNow = 1_000_000_000_000;
    const realDateNow = Date.now;
    try {
      Date.now = () => simulatedNow;
      agent.registerManualSideExpectation('AAA', 'BUY', 1000); // min TTL clamps to 1000ms
      agent.registerManualSideExpectation('BBB', 'SELL', 1000);
      expect(agent.manualSideExpectations.size).toBe(2);
      simulatedNow += 5000; // both TTLs long expired
      agent.registerManualSideExpectation('CCC', 'BUY', 60000);
      const map: Map<string, { side: string; expiresAt: number }> = agent.manualSideExpectations;
      expect(map.has('AAA')).toBe(false);
      expect(map.has('BBB')).toBe(false);
      expect(map.has('CCC')).toBe(true);
      expect(map.size).toBe(1);
    } finally {
      Date.now = realDateNow;
      agent.stop();
    }
  });

  it('never evicts a still-live (unexpired) entry', () => {
    const agent = new ChiefTraderAgent() as any;
    let simulatedNow = 2_000_000_000_000;
    const realDateNow = Date.now;
    try {
      Date.now = () => simulatedNow;
      agent.registerManualSideExpectation('LIVE1', 'BUY', 60000);
      simulatedNow += 5000; // 5s in, still 55s of TTL left
      agent.registerManualSideExpectation('LIVE2', 'SELL', 60000); // triggers a sweep pass
      const map: Map<string, { side: string; expiresAt: number }> = agent.manualSideExpectations;
      expect(map.has('LIVE1')).toBe(true);
      expect(map.get('LIVE1')!.side).toBe('BUY');
      expect(map.has('LIVE2')).toBe(true);
    } finally {
      Date.now = realDateNow;
      agent.stop();
    }
  });
});
