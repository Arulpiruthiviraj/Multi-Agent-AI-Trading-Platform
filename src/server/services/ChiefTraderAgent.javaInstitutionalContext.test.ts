import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same hoisted mock scaffolding as ChiefTraderAgent.test.ts so importing ChiefTraderAgent.ts
// here doesn't reach a real DB / EventBus / AIRouter - this file only exercises
// loadJavaInstitutionalDebateContext(), never evaluateConsensus().
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
vi.mock('../db', () => ({ db: mockDb }));
vi.mock('../core/EventBus', () => ({ eventBus: { on: vi.fn(), emit: vi.fn(), publish: vi.fn() } }));
vi.mock('../ai/AIRouter', () => ({ AIRouter: { getInstance: () => ({ routeConsensus: vi.fn(), routeTask: vi.fn(), hasAnyRoutableProvider: vi.fn() }) } }));
vi.mock('../core/ideaGenerationGate', () => ({ isLiveIdeaGenerationEnabled: () => true }));

const { javaCoreEnabled } = vi.hoisted(() => ({ javaCoreEnabled: { value: true } }));
vi.mock('../config/tradingSafety', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/tradingSafety')>();
  return { ...actual, isQuantJavaCoreEnabled: () => javaCoreEnabled.value };
});

const { ensureBars, getBars } = vi.hoisted(() => ({ ensureBars: vi.fn(), getBars: vi.fn() }));
vi.mock('../engines/backtest/HistoricalDataGateway', () => ({
  historicalDataGateway: { ensureBars, getBars },
}));

const { fetchInstitutionalVolatility, fetchInstitutionalRegime, fetchInstitutionalFactors } = vi.hoisted(() => ({
  fetchInstitutionalVolatility: vi.fn(),
  fetchInstitutionalRegime: vi.fn(),
  fetchInstitutionalFactors: vi.fn(),
}));
vi.mock('./QuantCoreBridge', () => ({
  quantCoreBridge: { fetchInstitutionalVolatility, fetchInstitutionalRegime, fetchInstitutionalFactors },
}));

import { loadJavaInstitutionalDebateContext } from './ChiefTraderAgent';
import { MIN_BARS_FOR_ANALYSIS } from './JavaQuantAdvisoryService';

const enoughBars = Array.from({ length: MIN_BARS_FOR_ANALYSIS + 1 }, (_, i) => ({
  timestamp: i, open: 100, high: 101, low: 99, close: 100, volume: 1000,
}));

const factorResult = {
  schemaVersion: 1, symbol: 'AAPL', momentum: 0.5, meanReversion: -0.2, volumeLiquidity: 0.1,
  volatility: -0.3, orderFlowProxy: 0.05, orderFlowProxyIsRealOrderFlow: false as const, composite: 0.13,
};
const regimeResult = { schemaVersion: 1, symbol: 'AAPL', currentRegime: 'BULL_TRENDING' as const, logLikelihood: -12.3, observationCount: 200, stateLabels: [] };
const garchResult = {
  schemaVersion: 1, symbol: 'AAPL', omega: 0.001, alpha: 0.1, beta: 0.8, persistence: 0.9,
  realizedVolatility: 0.021, realizedVolPercentile: 62, volatilityCompressed: false, volatilityExpanded: false,
} as any;

describe('loadJavaInstitutionalDebateContext', () => {
  beforeEach(() => {
    javaCoreEnabled.value = true;
    ensureBars.mockReset().mockResolvedValue(undefined);
    getBars.mockReset().mockResolvedValue(enoughBars);
    fetchInstitutionalVolatility.mockReset().mockResolvedValue(garchResult);
    fetchInstitutionalRegime.mockReset().mockResolvedValue(regimeResult);
    fetchInstitutionalFactors.mockReset().mockResolvedValue(factorResult);
  });

  it('returns empty string when isQuantJavaCoreEnabled() is false - zero bars/HTTP calls', async () => {
    javaCoreEnabled.value = false;
    const text = await loadJavaInstitutionalDebateContext('AAPL');
    expect(text).toBe('');
    expect(ensureBars).not.toHaveBeenCalled();
    expect(fetchInstitutionalFactors).not.toHaveBeenCalled();
  });

  it('returns empty string when there is not enough bar history', async () => {
    getBars.mockResolvedValue(enoughBars.slice(0, MIN_BARS_FOR_ANALYSIS - 1));
    const text = await loadJavaInstitutionalDebateContext('AAPL');
    expect(text).toBe('');
    expect(fetchInstitutionalFactors).not.toHaveBeenCalled();
  });

  it('builds context text from all three models when all are available', async () => {
    const text = await loadJavaInstitutionalDebateContext('AAPL');
    expect(text).toContain('Java institutional analysis');
    expect(text).toContain('does not vote or override RiskEngine');
    expect(text).toContain('Factor composite 0.130');
    expect(text).toContain('Regime: BULL_TRENDING');
    expect(text).toContain('GARCH(1,1): realized volatility 2.10%');
  });

  it('omits a model that returns null but still builds text from the others', async () => {
    fetchInstitutionalRegime.mockResolvedValue(null);
    const text = await loadJavaInstitutionalDebateContext('AAPL');
    expect(text).toContain('Factor composite');
    expect(text).not.toContain('Regime:');
    expect(text).toContain('GARCH(1,1)');
  });

  it('returns empty string when all three models return null', async () => {
    fetchInstitutionalVolatility.mockResolvedValue(null);
    fetchInstitutionalRegime.mockResolvedValue(null);
    fetchInstitutionalFactors.mockResolvedValue(null);
    const text = await loadJavaInstitutionalDebateContext('AAPL');
    expect(text).toBe('');
  });

  it('fails closed to empty string when the bars fetch throws', async () => {
    ensureBars.mockRejectedValue(new Error('historical data gateway unavailable'));
    const text = await loadJavaInstitutionalDebateContext('AAPL');
    expect(text).toBe('');
  });

  it('fails closed to empty string when a Java bridge call rejects', async () => {
    fetchInstitutionalFactors.mockRejectedValue(new Error('quant core unreachable'));
    const text = await loadJavaInstitutionalDebateContext('AAPL');
    expect(text).toBe('');
  });
});
