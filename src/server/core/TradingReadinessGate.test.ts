import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Trading Readiness Gate - proves "process alive" and "trading ready" are structurally distinct,
 * per the Zero-Trade Forensic Audit follow-up. Each dependency mocked independently so every
 * combination (all healthy, AI layer down, market data down, etc.) is directly testable.
 */
const { health } = vi.hoisted(() => ({ health: vi.fn() }));
const { brokerReadiness } = vi.hoisted(() => ({ brokerReadiness: vi.fn() }));
const { getMarketDataReadiness } = vi.hoisted(() => ({ getMarketDataReadiness: vi.fn() }));
vi.mock('./marketDataReadiness', () => ({ getMarketDataReadiness }));
const { getPipelineAgentSnapshot } = vi.hoisted(() => ({ getPipelineAgentSnapshot: vi.fn() }));
const { getAIProviderHealthSnapshot } = vi.hoisted(() => ({ getAIProviderHealthSnapshot: vi.fn() }));
const { dbSelectResult } = vi.hoisted(() => ({ dbSelectResult: { value: Promise.resolve([{}]) } }));

vi.mock('./ArgusRuntime', () => ({ argusRuntime: { health, brokerReadiness } }));
vi.mock('./pipelineAgentSnapshot', () => ({ getPipelineAgentSnapshot }));
vi.mock('../ai/AIProviderHealthCheck', () => ({ getAIProviderHealthSnapshot }));
vi.mock('../db', () => ({
  db: { select: () => ({ from: () => ({ limit: () => dbSelectResult.value }) }) },
}));

import { getTradingReadinessSnapshot, renderTradingReadinessTree } from './TradingReadinessGate';

function healthyDefaults() {
  brokerReadiness.mockResolvedValue({ ready: true, detail: 'ibkr_gateway: Healthy' });
  getMarketDataReadiness.mockReturnValue({ ready: true, detail: 'connected; 1/1 active symbols have a valid fresh quote' });
  health.mockReturnValue({
    ok: true,
    pid: 12345,
    uptimeMs: 60000,
    marketDataConnected: true,
    brokerId: 'ibkr_gateway',
  });
  getPipelineAgentSnapshot.mockReturnValue({
    liveIdeaGenerationEnabled: true, autobotEnabled: true, tradingState: 'TRADING_ENABLED', interruptedSessionHold: false,
    togglable: [
      { id: 'TechnicalAgent', healthy: true, healthLabel: 'RUNNING', available: true },
      { id: 'QuantEngine', healthy: true, healthLabel: 'RUNNING', available: true },
    ],
  });
  getAIProviderHealthSnapshot.mockResolvedValue([
    { providerId: 'p1', providerName: 'Gemini', status: 'HEALTHY' },
    { providerId: 'p2', providerName: 'OpenAI', status: 'AUTH_FAILED' },
  ]);
  dbSelectResult.value = Promise.resolve([{ budget: 2000 }]);
}

describe('TradingReadinessGate', () => {
  it('reports the restart hold even with healthy market data, agents and broker', async () => {
    getPipelineAgentSnapshot.mockReturnValue({ ...getPipelineAgentSnapshot(), liveIdeaGenerationEnabled: false, interruptedSessionHold: true });
    const snapshot = await getTradingReadinessSnapshot();
    expect(snapshot.tradingReady).toBe(false);
    expect(snapshot.nodes.find(n => n.id === 'entryGeneration')).toMatchObject({ ready: false, detail: expect.stringContaining('reconciliation match') });
    expect(renderTradingReadinessTree(snapshot)).toContain('unclean restart');
  });

  it.each([
    [{ tradingState: 'TRADING_PAUSED' }, 'TRADING_PAUSED'],
    [{ autobotEnabled: false }, 'Autobot disabled'],
    [{ forensicCheckpointBuyLock: { locked: true } }, 'forensic checkpoint'],
  ])('exposes an entry gate independently of worker health: %s', async (fields, reason) => {
    getPipelineAgentSnapshot.mockReturnValue({ ...getPipelineAgentSnapshot(), ...fields, liveIdeaGenerationEnabled: false });
    const snapshot = await getTradingReadinessSnapshot();
    expect(snapshot.tradingReady).toBe(false);
    expect(snapshot.reasons.join(' ')).toContain(reason);
  });
  it('fails broker readiness when sync/selection exist but the session is offline', async () => {
    brokerReadiness.mockResolvedValue({ ready: false, detail: 'ibkr_gateway: session not authenticated' });
    const result = await getTradingReadinessSnapshot();
    expect(result.nodes.find(n => n.id === 'broker')).toMatchObject({ ready: false });
    expect(result.tradingReady).toBe(false);
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T15:00:00Z'));
    vi.stubEnv('ARGUS_EXPECTED_BUDGET', '2000');
    health.mockReset();
    getPipelineAgentSnapshot.mockReset();
    getAIProviderHealthSnapshot.mockReset();
    healthyDefaults();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it('reports tradingReady=true when every dependency (including at least one healthy AI provider) is healthy', async () => {
    const snapshot = await getTradingReadinessSnapshot();
    expect(snapshot.tradingReady).toBe(true);
    expect(snapshot.reasons).toEqual([]);
  });

  describe('capital profile / budget consistency (2026-10-05)', () => {
    it('marks the capital node ready when settings.budget matches the declared intent', async () => {
      const snapshot = await getTradingReadinessSnapshot();
      const node = snapshot.nodes.find((n) => n.id === 'capitalProfile')!;
      expect(node.ready).toBe(true);
      expect(node.notApplicable).toBeFalsy();
      expect(node.detail).toContain('$2,000');
      expect(snapshot.tradingReady).toBe(true);
    });

    it('fails closed with BUDGET_MISMATCH when runtime budget differs from declared intent', async () => {
      dbSelectResult.value = Promise.resolve([{ budget: 100000 }]);
      const snapshot = await getTradingReadinessSnapshot();
      const node = snapshot.nodes.find((n) => n.id === 'capitalProfile')!;
      expect(node.ready).toBe(false);
      expect(node.detail).toContain('BUDGET_MISMATCH');
      expect(node.detail).toContain('$100,000');
      expect(node.detail).toContain('$2,000');
      expect(snapshot.tradingReady).toBe(false);
      expect(snapshot.reasons.some((r) => r.includes('BUDGET_MISMATCH'))).toBe(true);
    });

    it('fails closed when settings.budget is missing or not positive', async () => {
      dbSelectResult.value = Promise.resolve([{}]);
      const snapshot = await getTradingReadinessSnapshot();
      const node = snapshot.nodes.find((n) => n.id === 'capitalProfile')!;
      expect(node.ready).toBe(false);
      expect(snapshot.tradingReady).toBe(false);
    });

    it('is notApplicable (passing) when no intent is declared via ARGUS_EXPECTED_BUDGET', async () => {
      vi.stubEnv('ARGUS_EXPECTED_BUDGET', '');
      const snapshot = await getTradingReadinessSnapshot();
      const node = snapshot.nodes.find((n) => n.id === 'capitalProfile')!;
      expect(node.ready).toBe(true);
      expect(node.notApplicable).toBe(true);
      expect(snapshot.tradingReady).toBe(true);
    });

    it('fails closed when ARGUS_EXPECTED_BUDGET itself is not a positive number', async () => {
      vi.stubEnv('ARGUS_EXPECTED_BUDGET', 'banana');
      const snapshot = await getTradingReadinessSnapshot();
      const node = snapshot.nodes.find((n) => n.id === 'capitalProfile')!;
      expect(node.ready).toBe(false);
      expect(snapshot.tradingReady).toBe(false);
    });

    it('never throws when the settings read fails - reports not-ready instead', async () => {
      const rejected = Promise.reject(new Error('SQLITE_BUSY'));
      rejected.catch(() => {});
      dbSelectResult.value = rejected;
      const snapshot = await getTradingReadinessSnapshot();
      expect(snapshot.nodes.find((n) => n.id === 'capitalProfile')!.ready).toBe(false);
      expect(snapshot.tradingReady).toBe(false);
    });
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
    getMarketDataReadiness.mockReturnValue({ ready: false, detail: 'disconnected' });
    health.mockReturnValue({ ok: true, pid: 1, uptimeMs: 1000, marketDataConnected: false, brokerId: 'ibkr_gateway' });

    const snapshot = await getTradingReadinessSnapshot();

    expect(snapshot.nodes.find((n) => n.id === 'process')!.ready).toBe(true);
    expect(snapshot.nodes.find((n) => n.id === 'marketData')!.ready).toBe(false);
    expect(snapshot.tradingReady).toBe(false);
  });

  it('does not penalize tradingReady when Quant Engine is intentionally disabled by config (notApplicable)', async () => {
    getPipelineAgentSnapshot.mockReturnValue({
    liveIdeaGenerationEnabled: true, autobotEnabled: true, tradingState: 'TRADING_ENABLED', interruptedSessionHold: false,
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

  it('does not report tradingReady=false purely because Technical/Quant are IDLE_WAITING_FOR_MARKET_DATA pre-market (2026-08-25 fix)', async () => {
    vi.setSystemTime(new Date('2026-09-18T12:00:00Z'));
    // Confirmed live: before this fix, every single pre-market ./argus pipeline-ready check
    // reported tradingReady=false with reason "Technical engine not running", even though
    // IDLE_WAITING_FOR_MARKET_DATA is the documented, expected pre-market/warmup state
    // (CLAUDE.md "Technical after ~50 ticks") - not a real failure.
    getPipelineAgentSnapshot.mockReturnValue({
    liveIdeaGenerationEnabled: true, autobotEnabled: true, tradingState: 'TRADING_ENABLED', interruptedSessionHold: false,
      togglable: [
        { id: 'TechnicalAgent', healthy: false, healthLabel: 'IDLE_WAITING_FOR_MARKET_DATA', available: true },
        { id: 'QuantEngine', healthy: false, healthLabel: 'IDLE_WAITING_FOR_MARKET_DATA', available: true },
      ],
    });

    const snapshot = await getTradingReadinessSnapshot();

    const technicalNode = snapshot.nodes.find((n) => n.id === 'technicalEngine')!;
    const quantNode = snapshot.nodes.find((n) => n.id === 'quantEngine')!;
    expect(technicalNode.ready).toBe(true);
    expect(technicalNode.notApplicable).toBe(true);
    expect(technicalNode.detail).toBe('IDLE_WAITING_FOR_MARKET_DATA');
    expect(quantNode.ready).toBe(true);
    expect(quantNode.notApplicable).toBe(true);
    expect(snapshot.tradingReady).toBe(true);
    expect(snapshot.reasons.some((r) => r.includes('Technical engine not running'))).toBe(false);
  });

  it('still reports Technical engine not ready when it is genuinely FAILED, not merely waiting for data', async () => {
    getPipelineAgentSnapshot.mockReturnValue({
    liveIdeaGenerationEnabled: true, autobotEnabled: true, tradingState: 'TRADING_ENABLED', interruptedSessionHold: false,
      togglable: [
        { id: 'TechnicalAgent', healthy: false, healthLabel: 'FAILED', available: true },
        { id: 'QuantEngine', healthy: true, healthLabel: 'RUNNING', available: true },
      ],
    });

    const snapshot = await getTradingReadinessSnapshot();

    const technicalNode = snapshot.nodes.find((n) => n.id === 'technicalEngine')!;
    expect(technicalNode.ready).toBe(false);
    expect(technicalNode.notApplicable).toBeFalsy();
    expect(snapshot.tradingReady).toBe(false);
    expect(snapshot.reasons.some((r) => r.includes('Technical engine not running'))).toBe(true);
  });

  it('renderTradingReadinessTree produces the ASCII tree shape with a final TRADING READY line', async () => {
    const snapshot = await getTradingReadinessSnapshot();
    const tree = renderTradingReadinessTree(snapshot);
    expect(tree).toContain('ARGUS');
    expect(tree).toContain('TRADING READY');
    expect(tree).toContain('Gemini');
    expect(tree).toContain('OpenAI');
  });

  it('reports no usable market data despite a connected socket and healthy AI', async () => {
    getMarketDataReadiness.mockReturnValue({ ready: false, detail: 'connected; 0/90 active symbols have a valid fresh quote' });
    const result = await getTradingReadinessSnapshot();
    expect(result.tradingReady).toBe(false);
    expect(result.nodes.find(n => n.id === 'marketData')).toMatchObject({ ready: false });
    expect(result.reasons.join(' ')).toContain('0/90');
  });

  it('does not excuse a never-ticked TechnicalAgent during the regular session', async () => {
    getPipelineAgentSnapshot.mockReturnValue({
    liveIdeaGenerationEnabled: true, autobotEnabled: true, tradingState: 'TRADING_ENABLED', interruptedSessionHold: false, togglable: [
      { id: 'TechnicalAgent', healthy: false, healthLabel: 'IDLE_WAITING_FOR_MARKET_DATA', available: true },
      { id: 'QuantEngine', healthy: true, healthLabel: 'RUNNING', available: true },
    ] });
    const result = await getTradingReadinessSnapshot();
    expect(result.tradingReady).toBe(false);
    expect(result.nodes.find(n => n.id === 'technicalEngine')).toMatchObject({ ready: false, notApplicable: false });
  });
});
