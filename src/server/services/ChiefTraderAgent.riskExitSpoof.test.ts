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
import { agentWeightConfig } from '../config/agentWeights';

/**
 * Real defect found and fixed (2026-10-08 defect hunt, core F3): the risk-exit
 * fast path (skips the debate) keyed on a self-reported agent string alone. Any
 * emitter setting agent='PortfolioManager', side='SELL' inherited the debate
 * skip. isRiskExit now requires the agent name AND origin='PORTFOLIO_EXIT'
 * (stamped only by PortfolioMonitor.emitRiskExit).
 */
describe('ChiefTraderAgent.isRiskExit (real defect: self-reported agent string bypass)', () => {
  const agentName = (agentWeightConfig as any).riskExitAgent as string;

  function makeAgent(): any {
    return new ChiefTraderAgent();
  }

  it('accepts the genuine PortfolioMonitor shape (agent name + PORTFOLIO_EXIT origin)', () => {
    const agent = makeAgent();
    try {
      expect(agent.isRiskExit({ agent: agentName, side: 'SELL', origin: 'PORTFOLIO_EXIT' })).toBe(true);
    } finally {
      agent.stop();
    }
  });

  it('rejects a spoofed agent name without the PORTFOLIO_EXIT origin', () => {
    const agent = makeAgent();
    try {
      expect(agent.isRiskExit({ agent: agentName, side: 'SELL', origin: 'NEWS_AGENT' })).toBe(false);
      expect(agent.isRiskExit({ agent: agentName, side: 'SELL', origin: 'OTHER' })).toBe(false);
      expect(agent.isRiskExit({ agent: agentName, side: 'SELL' })).toBe(false);
      // ...including the mis-tagged-quant case from the router test.
      expect(agent.isRiskExit({ agent: agentName, side: 'SELL', origin: 'QUANT_STRATEGY' })).toBe(false);
    } finally {
      agent.stop();
    }
  });

  it('a mis-tagged exit is still exit-shaped (never enters the quant router) but loses the debate skip', () => {
    const agent = makeAgent();
    try {
      const misTagged = { agent: agentName, side: 'SELL', origin: 'QUANT_STRATEGY' };
      expect(agent.isExitShaped(misTagged)).toBe(true);
      expect(agent.isRiskExit(misTagged)).toBe(false);
    } finally {
      agent.stop();
    }
  });

  it('rejects wrong side and wrong agent even with the right origin', () => {
    const agent = makeAgent();
    try {
      expect(agent.isRiskExit({ agent: agentName, side: 'BUY', origin: 'PORTFOLIO_EXIT' })).toBe(false);
      expect(agent.isRiskExit({ agent: 'SomeOtherAgent', side: 'SELL', origin: 'PORTFOLIO_EXIT' })).toBe(false);
    } finally {
      agent.stop();
    }
  });
});
