import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Trading Readiness Gate - proves "process alive" and "trading ready" are structurally distinct,
 * per the Zero-Trade Forensic Audit follow-up. Each dependency mocked independently so every
 * combination (all healthy, AI layer down, market data down, etc.) is directly testable.
 */
const { health } = vi.hoisted(() => ({ health: vi.fn() }));
const { getPipelineAgentSnapshot } = vi.hoisted(() => ({ getPipelineAgentSnapshot: vi.fn() }));
const { getAIProviderHealthSnapshot } = vi.hoisted(() => ({ getAIProviderHealthSnapshot: vi.fn() }));
const { dbSelectResult } = vi.hoisted(() => ({ dbSelectResult: { value: Promise.resolve([{}]) } }));

vi.mock('./ArgusRuntime', () => ({ argusRuntime: { health } }));
vi.mock('./pipelineAgentSnapshot', () => ({ getPipelineAgentSnapshot }));
vi.mock('../ai/AIProviderHealthCheck', () => ({ getAIProviderHealthSnapshot }));
vi.mock('../db', () => ({
  db: { select: () => ({ from: () => ({ limit: () => dbSelectResult.value }) }) },
}));

import { getTradingReadinessSnapshot, renderTradingReadinessTree } from './TradingReadinessGate';

function healthyDefaults() {
  health.mockReturnValue({
    ok: true,
    pid: 12345,
    uptimeMs: 60000,
    marketDataConnected: true,
    brokerId: 'ibkr_gateway',
  });
  getPipelineAgentSnapshot.mockReturnValue({
    togglable: [
      { id: 'TechnicalAgent', healthy: true, healthLabel: 'RUNNING', available: true },
      { id: 'QuantEngine', healthy: true, healthLabel: 'RUNNING', available: true },
    ],
  });
  getAIProviderHealthSnapshot.mockResolvedValue([
    { providerId: 'p1', providerName: 'Gemini', status: 'HEALTHY' },
    { providerId: 'p2', providerName: 'OpenAI', status: 'AUTH_FAILED' },
  ]);
  dbSelectResult.value = Promise.resolve([{}]);
}

describe('TradingReadinessGate', () => {
  beforeEach(() => {
    health.mockReset();
    getPipelineAgentSnapshot.mockReset();
    getAIProviderHealthSnapshot.mockReset();
    healthyDefaults();
  });

  it('reports tradingReady=true when every dependency (including at least one healthy AI provider) is healthy', async () => {
    const snapshot = await getTradingReadinessSnapshot();
    expect(snapshot.tradingReady).toBe(true);
    expect(snapshot.reasons).toEqual([]);
  });

  it('reports tradingReady=false when the AI provider layer has zero healthy providers - the exact zero-trade-audit scenario', async () => {
    getAIProviderHealthSnapshot.mockResolvedValue([
      { providerId: 'p1', providerName: 'Gemini', status: 'AUTH_FAILED' },
      { providerId: 'p2', providerName: 'OpenAI', status: 'AUTH_FAILED' },
      { providerId: 'p3', providerName: 'Claude', status: 'AUTH_FAILED' },
    ]);

    const snapshot = await getTradingReadinessSnapshot();

    expect(snapshot.tradingReady).toBe(false);
    const aiNode = snapshot.nodes.find((n) => n.id === 'aiProviderLayer')!;
    expect(aiNode.ready).toBe(false);
    expect(aiNode.children?.every((c) => !c.ready)).toBe(true);
    expect(snapshot.reasons.some((r) => r.includes('AI provider'))).toBe(true);
    // Process/database/marketData/broker/technical/quant are still individually reported ready -
    // this proves the distinction the gate exists for: alive != trading-ready.
    expect(snapshot.nodes.find((n) => n.id === 'process')!.ready).toBe(true);
    expect(snapshot.nodes.find((n) => n.id === 'marketData')!.ready).toBe(true);
  });

  it('reports tradingReady=false when market data is disconnected even though the process is alive', async () => {
    health.mockReturnValue({ ok: true, pid: 1, uptimeMs: 1000, marketDataConnected: false, brokerId: 'ibkr_gateway' });

    const snapshot = await getTradingReadinessSnapshot();

    expect(snapshot.nodes.find((n) => n.id === 'process')!.ready).toBe(true);
    expect(snapshot.nodes.find((n) => n.id === 'marketData')!.ready).toBe(false);
    expect(snapshot.tradingReady).toBe(false);
  });

  it('does not penalize tradingReady when Quant Engine is intentionally disabled by config (notApplicable)', async () => {
    getPipelineAgentSnapshot.mockReturnValue({
      togglable: [
        { id: 'TechnicalAgent', healthy: true, healthLabel: 'RUNNING', available: true },
        { id: 'QuantEngine', healthy: false, healthLabel: 'GATED', available: false },
      ],
    });

    const snapshot = await getTradingReadinessSnapshot();
    const quantNode = snapshot.nodes.find((n) => n.id === 'quantEngine')!;
    expect(quantNode.notApplicable).toBe(true);
    expect(quantNode.ready).toBe(true);
    expect(snapshot.tradingReady).toBe(true);
  });

  it('reports tradingReady=false when the database is unreachable', async () => {
    const rejected = Promise.reject(new Error('SQLITE_BUSY'));
    rejected.catch(() => {}); // silence Node's unhandled-rejection warning; the module still awaits this same promise
    dbSelectResult.value = rejected;

    const snapshot = await getTradingReadinessSnapshot();

    expect(snapshot.nodes.find((n) => n.id === 'database')!.ready).toBe(false);
    expect(snapshot.tradingReady).toBe(false);
  });

  it('reports broker not-ready when health() has no active broker, without needing a separate BrokerManager import', async () => {
    health.mockReturnValue({ ok: true, pid: 1, uptimeMs: 1000, marketDataConnected: true, brokerId: null });

    const snapshot = await getTradingReadinessSnapshot();

    expect(snapshot.nodes.find((n) => n.id === 'broker')!.ready).toBe(false);
    expect(snapshot.reasons.some((r) => r.includes('Broker'))).toBe(true);
  });

  it('never throws even when every dependency check fails - reports not-ready instead', async () => {
    health.mockImplementation(() => { throw new Error('boom'); });
    getPipelineAgentSnapshot.mockImplementation(() => { throw new Error('boom'); });
    getAIProviderHealthSnapshot.mockRejectedValue(new Error('boom'));
    const rejected = Promise.reject(new Error('boom'));
    rejected.catch(() => {}); // silence Node's unhandled-rejection warning; the module below still awaits this same promise and sees the real rejection
    dbSelectResult.value = rejected;

    const snapshot = await getTradingReadinessSnapshot();

    expect(snapshot.tradingReady).toBe(false);
    expect(snapshot.nodes.find((n) => n.id === 'process')!.ready).toBe(false);
    expect(snapshot.nodes.find((n) => n.id === 'database')!.ready).toBe(false);
    expect(snapshot.nodes.find((n) => n.id === 'broker')!.ready).toBe(false);
    expect(snapshot.nodes.find((n) => n.id === 'aiProviderLayer')!.ready).toBe(false);
  });

  it('renderTradingReadinessTree produces the ASCII tree shape with a final TRADING READY line', async () => {
    const snapshot = await getTradingReadinessSnapshot();
    const tree = renderTradingReadinessTree(snapshot);
    expect(tree).toContain('ARGUS');
    expect(tree).toContain('TRADING READY');
    expect(tree).toContain('Gemini');
    expect(tree).toContain('OpenAI');
  });
});
