import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { historicalDataGateway } from '../engines/backtest/HistoricalDataGateway';
import { quantCoreBridge } from './QuantCoreBridge';
import { resolveIdeaUniverse } from '../core/ideaUniverse';
import { javaQuantAdvisoryService } from './JavaQuantAdvisoryService';

vi.mock('../engines/backtest/HistoricalDataGateway', () => ({
  historicalDataGateway: {
    ensureBars: vi.fn(),
    getBars: vi.fn(),
  },
}));
vi.mock('./QuantCoreBridge', () => ({
  quantCoreBridge: {
    fetchInstitutionalVolatility: vi.fn(),
    fetchInstitutionalRegime: vi.fn(),
    fetchInstitutionalFactors: vi.fn(),
  },
}));
vi.mock('../core/ideaUniverse', () => ({
  resolveIdeaUniverse: vi.fn(),
}));

const bars = Array.from({ length: 90 }, (_, i) => ({
  timestamp: i, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1000,
}));

describe('JavaQuantAdvisoryService - Phase 2 activation, advisory-only', () => {
  beforeEach(() => {
    delete process.env.QUANT_JAVA_CORE_ENABLED;
    vi.mocked(historicalDataGateway.ensureBars).mockReset().mockResolvedValue(undefined);
    vi.mocked(historicalDataGateway.getBars).mockReset().mockResolvedValue(bars as any);
    vi.mocked(quantCoreBridge.fetchInstitutionalVolatility).mockReset().mockResolvedValue({ symbol: 'AAPL', alpha: 0.05 } as any);
    vi.mocked(quantCoreBridge.fetchInstitutionalRegime).mockReset().mockResolvedValue({ symbol: 'AAPL', currentRegime: 'BULL_TRENDING' } as any);
    vi.mocked(quantCoreBridge.fetchInstitutionalFactors).mockReset().mockResolvedValue({ symbol: 'AAPL', composite: 0.3 } as any);
    vi.mocked(resolveIdeaUniverse).mockReset().mockReturnValue(['AAPL']);
  });

  afterEach(() => {
    javaQuantAdvisoryService.stop();
    delete process.env.QUANT_JAVA_CORE_ENABLED;
    vi.restoreAllMocks();
  });

  it('analyzeSymbol() is a no-op (never fetches bars) when QUANT_JAVA_CORE_ENABLED is off (default)', async () => {
    await javaQuantAdvisoryService.analyzeSymbol('AAPL');
    expect(historicalDataGateway.ensureBars).not.toHaveBeenCalled();
    expect(quantCoreBridge.fetchInstitutionalVolatility).not.toHaveBeenCalled();
  });

  it('emits QUANT_ADVISORY_ANALYSIS_COMPLETED with all three models when enabled and bars are sufficient', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    const emitSpy = vi.spyOn(eventBus, 'emit');

    await javaQuantAdvisoryService.analyzeSymbol('AAPL');

    expect(historicalDataGateway.ensureBars).toHaveBeenCalledWith('AAPL', '1Day', expect.any(Number), expect.any(Number));
    expect(quantCoreBridge.fetchInstitutionalVolatility).toHaveBeenCalledWith('AAPL', bars);
    expect(quantCoreBridge.fetchInstitutionalRegime).toHaveBeenCalledWith('AAPL', bars);
    expect(quantCoreBridge.fetchInstitutionalFactors).toHaveBeenCalledWith('AAPL', bars);

    const call = emitSpy.mock.calls.find((c) => c[0] === EVENTS.QUANT_ADVISORY_ANALYSIS_COMPLETED);
    expect(call).toBeDefined();
    const payload = call![1] as any;
    expect(payload.symbol).toBe('AAPL');
    expect(payload.models.garch).toEqual({ symbol: 'AAPL', alpha: 0.05 });
    expect(payload.models.regime).toEqual({ symbol: 'AAPL', currentRegime: 'BULL_TRENDING' });
    expect(payload.models.factor).toEqual({ symbol: 'AAPL', composite: 0.3 });
    expect(payload.health.javaAvailable).toBe(true);
  });

  it('never calls emitTradeIdea - this is observability only, not a vote', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    const emitTradeIdeaSpy = vi.spyOn(eventBus, 'emitTradeIdea');

    await javaQuantAdvisoryService.analyzeSymbol('AAPL');

    expect(emitTradeIdeaSpy).not.toHaveBeenCalled();
  });

  it('skips analysis (no emit) when fewer bars than the minimum are available', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    vi.mocked(historicalDataGateway.getBars).mockResolvedValue(bars.slice(0, 10) as any);
    const emitSpy = vi.spyOn(eventBus, 'emit');

    await javaQuantAdvisoryService.analyzeSymbol('AAPL');

    expect(quantCoreBridge.fetchInstitutionalVolatility).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalledWith(EVENTS.QUANT_ADVISORY_ANALYSIS_COMPLETED, expect.anything());
  });

  it('fails closed (no throw, no emit) when the real bar fetch throws', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    vi.mocked(historicalDataGateway.ensureBars).mockRejectedValue(new Error('ALPACA_DOWN'));
    const emitSpy = vi.spyOn(eventBus, 'emit');

    await expect(javaQuantAdvisoryService.analyzeSymbol('AAPL')).resolves.toBeUndefined();
    expect(emitSpy).not.toHaveBeenCalledWith(EVENTS.QUANT_ADVISORY_ANALYSIS_COMPLETED, expect.anything());
  });

  it('reports health.javaAvailable=false when every Java call fails, without throwing', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    vi.mocked(quantCoreBridge.fetchInstitutionalVolatility).mockResolvedValue(null);
    vi.mocked(quantCoreBridge.fetchInstitutionalRegime).mockResolvedValue(null);
    vi.mocked(quantCoreBridge.fetchInstitutionalFactors).mockResolvedValue(null);
    const emitSpy = vi.spyOn(eventBus, 'emit');

    await javaQuantAdvisoryService.analyzeSymbol('AAPL');

    const call = emitSpy.mock.calls.find((c) => c[0] === EVENTS.QUANT_ADVISORY_ANALYSIS_COMPLETED);
    expect((call![1] as any).health.javaAvailable).toBe(false);
  });
});
