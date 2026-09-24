import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { historicalDataGateway } from '../engines/backtest/HistoricalDataGateway';
import { quantCoreBridge } from './QuantCoreBridge';
import { resolveIdeaUniverse } from '../core/ideaUniverse';
import { recordPrediction } from './ModelPerformanceTracker';
import { javaQuantAdvisoryService, emitJavaQuantVoteIfEligible } from './JavaQuantAdvisoryService';
import { tradingEngine } from '../engines/TradingEngine';
import { setPipelineAgentEnabled } from '../core/pipelineAgentGate';
import { tradingSafety } from '../config/tradingSafety';
import type { QuantAdvisoryPayload } from './QuantAdvisoryPayload';
import {
  setObservabilityPersistForTests,
  resetObservabilityStoreForTests,
  flushObservabilityStore,
  type ObservabilityEventRow,
} from '../observability/ObservabilityStore';
import { emitQuantEvidenceObservability } from '../observability/quantEvidenceEmitter';

vi.mock('../observability/quantEvidenceEmitter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../observability/quantEvidenceEmitter')>();
  return { ...actual, emitQuantEvidenceObservability: vi.fn(actual.emitQuantEvidenceObservability) };
});

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
    fetchInstitutionalFeatures: vi.fn(),
    fetchInstitutionalCorrelation: vi.fn(),
    fetchInstitutionalAdvisory: vi.fn(),
  },
}));
vi.mock('../core/ideaUniverse', () => ({
  resolveIdeaUniverse: vi.fn(),
}));
vi.mock('./ModelPerformanceTracker', () => ({
  recordPrediction: vi.fn(),
}));

const bars = Array.from({ length: 90 }, (_, i) => ({
  timestamp: i, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1000,
}));

describe('JavaQuantAdvisoryService - Phase 2 activation, advisory-only', () => {
  beforeEach(() => {
    delete process.env.QUANT_JAVA_CORE_ENABLED;
    vi.mocked(historicalDataGateway.ensureBars).mockReset().mockResolvedValue(undefined);
    vi.mocked(historicalDataGateway.getBars).mockReset().mockResolvedValue(bars as any);
    vi.mocked(quantCoreBridge.fetchInstitutionalVolatility).mockReset().mockResolvedValue({ symbol: 'AAPL', alpha: 0.05, realizedVolatility: 0.018 } as any);
    vi.mocked(quantCoreBridge.fetchInstitutionalRegime).mockReset().mockResolvedValue({ symbol: 'AAPL', currentRegime: 'BULL_TRENDING' } as any);
    vi.mocked(quantCoreBridge.fetchInstitutionalFactors).mockReset().mockResolvedValue({ symbol: 'AAPL', composite: 0.3 } as any);
    vi.mocked(quantCoreBridge.fetchInstitutionalFeatures).mockReset().mockResolvedValue({ symbol: 'AAPL', rsi: 55 } as any);
    vi.mocked(quantCoreBridge.fetchInstitutionalAdvisory).mockReset().mockResolvedValue({
      rawSide: 'BUY',
      rawAvgConfidence: 0.6,
      rawEffectiveIndependentCount: 1,
      regime: 'BULL_TRENDING',
      regimeMultiplier: 1.0,
      currentVolatility: 0.018,
      volatilityMultiplier: 0.83,
      adjustedConfidence: 0.5,
      gated: false,
      reasoning: 'trend-aligned BUY, no discount',
      agreeingModelIds: ['factor_composite'],
      dissentingModelIds: [],
    } as any);
    vi.mocked(resolveIdeaUniverse).mockReset().mockReturnValue(['AAPL']);
    vi.mocked(recordPrediction).mockReset().mockResolvedValue(undefined);
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
    expect(quantCoreBridge.fetchInstitutionalFeatures).toHaveBeenCalledWith('AAPL', bars);
    expect(quantCoreBridge.fetchInstitutionalCorrelation).not.toHaveBeenCalled();

    const call = emitSpy.mock.calls.find((c) => c[0] === EVENTS.QUANT_ADVISORY_ANALYSIS_COMPLETED);
    expect(call).toBeDefined();
    const payload = call![1] as any;
    expect(payload.symbol).toBe('AAPL');
    expect(payload.models.garch).toEqual({ symbol: 'AAPL', alpha: 0.05, realizedVolatility: 0.018 });
    expect(payload.models.regime).toEqual({ symbol: 'AAPL', currentRegime: 'BULL_TRENDING' });
    expect(payload.models.factor).toEqual({ symbol: 'AAPL', composite: 0.3 });
    expect(payload.models.features).toEqual({ symbol: 'AAPL', rsi: 55 });
    expect(payload.models.correlation).toBeNull();
    expect(payload.health.javaAvailable).toBe(true);
  });

  it('never calls emitTradeIdea - this is observability only, not a vote', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    const emitTradeIdeaSpy = vi.spyOn(eventBus, 'emitTradeIdea');

    await javaQuantAdvisoryService.analyzeSymbol('AAPL');

    expect(emitTradeIdeaSpy).not.toHaveBeenCalled();
  });

  it('streams QUANT_ADVISORY_PAYLOAD_STREAMED and records a shadow prediction when garch/regime/factor all resolve with a non-zero composite', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    const emitSpy = vi.spyOn(eventBus, 'emit');

    await javaQuantAdvisoryService.analyzeSymbol('AAPL');

    expect(quantCoreBridge.fetchInstitutionalAdvisory).toHaveBeenCalledWith(
      [{ modelId: 'factor_composite', family: 'factor', side: 'BUY', confidence: expect.any(Number) }],
      'BULL_TRENDING',
      0.018,
    );

    const call = emitSpy.mock.calls.find((c) => c[0] === EVENTS.QUANT_ADVISORY_PAYLOAD_STREAMED);
    expect(call).toBeDefined();
    const payload = call![1] as any;
    expect(payload.executionEnvironment).toBe('ADVISORY_ONLY');
    expect(payload.symbol).toBe('AAPL');
    expect(payload.rawSide).toBe('BUY');
    expect(payload.adjustedConfidence).toBe(0.5);

    expect(recordPrediction).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'JavaFactorComposite',
      symbol: 'AAPL',
      side: 'BUY',
      confidence: 0.5,
      regime: 'BULL_TRENDING',
    }));
  });

  it('never attempts the advisory ensemble (no fetchInstitutionalAdvisory call, no recordPrediction) when the factor composite is zero', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    vi.mocked(quantCoreBridge.fetchInstitutionalFactors).mockResolvedValue({ symbol: 'AAPL', composite: 0 } as any);

    await javaQuantAdvisoryService.analyzeSymbol('AAPL');

    expect(quantCoreBridge.fetchInstitutionalAdvisory).not.toHaveBeenCalled();
    expect(recordPrediction).not.toHaveBeenCalled();
  });

  it('never attempts the advisory ensemble when regime or garch is null', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    vi.mocked(quantCoreBridge.fetchInstitutionalRegime).mockResolvedValue(null);

    await javaQuantAdvisoryService.analyzeSymbol('AAPL');

    expect(quantCoreBridge.fetchInstitutionalAdvisory).not.toHaveBeenCalled();
    expect(recordPrediction).not.toHaveBeenCalled();
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
    vi.mocked(quantCoreBridge.fetchInstitutionalFeatures).mockResolvedValue(null);
    const emitSpy = vi.spyOn(eventBus, 'emit');

    await javaQuantAdvisoryService.analyzeSymbol('AAPL');

    const call = emitSpy.mock.calls.find((c) => c[0] === EVENTS.QUANT_ADVISORY_ANALYSIS_COMPLETED);
    expect((call![1] as any).health.javaAvailable).toBe(false);
  });
});

describe('emitJavaQuantVoteIfEligible (2026-09-09, explicit operator override)', () => {
  const FLAG = 'ARGUS_JAVA_QUANT_VOTE_ENABLED';

  function advisory(overrides: Partial<QuantAdvisoryPayload> = {}): QuantAdvisoryPayload {
    return {
      schemaVersion: 1,
      executionEnvironment: 'ADVISORY_ONLY',
      symbol: 'AAPL',
      timestamp: new Date().toISOString(),
      rawSide: 'BUY',
      rawAvgConfidence: 0.7,
      rawEffectiveIndependentCount: 1,
      regime: 'BULL_TRENDING',
      regimeMultiplier: 1.0,
      currentVolatility: 0.02,
      volatilityMultiplier: 0.9,
      adjustedConfidence: 0.65, // clears the default javaQuantVoteMinConfidence (0.6)
      gated: false,
      reasoning: 'trend-aligned BUY',
      agreeingModelIds: ['factor_composite'],
      dissentingModelIds: [],
      ...overrides,
    } as QuantAdvisoryPayload;
  }

  beforeEach(() => {
    process.env[FLAG] = 'true';
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    setPipelineAgentEnabled('JavaFactorComposite', true);
  });

  afterEach(() => {
    delete process.env[FLAG];
    setPipelineAgentEnabled('JavaFactorComposite', true); // restore default for other test files
  });

  it('does nothing (FLAG_OFF) when ARGUS_JAVA_QUANT_VOTE_ENABLED is not true', () => {
    delete process.env[FLAG];
    expect(emitJavaQuantVoteIfEligible('AAPL', advisory(), 190)).toEqual({ emitted: false, reason: 'FLAG_OFF' });
  });

  it('does nothing (AGENT_DISABLED) when the JavaFactorComposite Mission Control toggle is off', () => {
    setPipelineAgentEnabled('JavaFactorComposite', false);
    expect(emitJavaQuantVoteIfEligible('AAPL', advisory(), 190)).toEqual({ emitted: false, reason: 'AGENT_DISABLED' });
  });

  it('does nothing (IDEA_GENERATION_GATED) when Autobot is off', () => {
    tradingEngine.state.enabled = false;
    expect(emitJavaQuantVoteIfEligible('AAPL', advisory(), 190)).toEqual({ emitted: false, reason: 'IDEA_GENERATION_GATED' });
  });

  it('does nothing (ADVISORY_GATED) when Java\'s own regime/volatility gating already flagged the signal untrustworthy', () => {
    expect(emitJavaQuantVoteIfEligible('AAPL', advisory({ gated: true }), 190)).toEqual({ emitted: false, reason: 'ADVISORY_GATED' });
  });

  it('does nothing (NEUTRAL_SIDE) when the advisory has no real directional call', () => {
    expect(emitJavaQuantVoteIfEligible('AAPL', advisory({ rawSide: 'NEUTRAL' }), 190)).toEqual({ emitted: false, reason: 'NEUTRAL_SIDE' });
  });

  it('does nothing (BELOW_MIN_CONFIDENCE) when adjustedConfidence has not cleared javaQuantVoteMinConfidence', () => {
    expect(emitJavaQuantVoteIfEligible('AAPL', advisory({ adjustedConfidence: tradingSafety.javaQuantVoteMinConfidence - 0.01 }), 190))
      .toEqual({ emitted: false, reason: 'BELOW_MIN_CONFIDENCE' });
  });

  it('does nothing (INVALID_PRICE) when no current price is available - never fabricates one', () => {
    expect(emitJavaQuantVoteIfEligible('AAPL', advisory(), null)).toEqual({ emitted: false, reason: 'INVALID_PRICE' });
    expect(emitJavaQuantVoteIfEligible('AAPL', advisory(), 0)).toEqual({ emitted: false, reason: 'INVALID_PRICE' });
    expect(emitJavaQuantVoteIfEligible('AAPL', advisory(), -5)).toEqual({ emitted: false, reason: 'INVALID_PRICE' });
  });

  it('emits exactly one real TRADE_IDEA_GENERATED, as agent JavaFactorComposite, when every gate clears', () => {
    const ideas: any[] = [];
    const onIdea = (p: any) => ideas.push(p);
    eventBus.subscribe(EVENTS.TRADE_IDEA_GENERATED, onIdea);
    try {
      const result = emitJavaQuantVoteIfEligible('AAPL', advisory(), 190);
      expect(result).toEqual({ emitted: true, reason: 'EMITTED' });
      expect(ideas.length).toBe(1);
      expect(ideas[0]).toMatchObject({
        symbol: 'AAPL',
        side: 'BUY',
        confidence: 0.65,
        currentPrice: 190,
        agent: 'JavaFactorComposite',
      });
    } finally {
      eventBus.unsubscribe(EVENTS.TRADE_IDEA_GENERATED, onIdea);
    }
  });

  describe('QuantEvidence observability (Milestone B.1, 2026-09-23)', () => {
    let captured: ObservabilityEventRow[];

    beforeEach(() => {
      captured = [];
      resetObservabilityStoreForTests();
      setObservabilityPersistForTests(async (batch) => { captured.push(...batch); });
    });

    afterEach(async () => {
      await flushObservabilityStore();
      setObservabilityPersistForTests(null);
      resetObservabilityStoreForTests();
    });

    it('emits a real QUANT_EVIDENCE_PRODUCED row on a vote-eligible path, with correct payload shape', async () => {
      const result = emitJavaQuantVoteIfEligible('AAPL', advisory(), 190);
      expect(result).toEqual({ emitted: true, reason: 'EMITTED' });
      await flushObservabilityStore();

      const row = captured.find((r) => r.eventType === 'QUANT_EVIDENCE_PRODUCED');
      expect(row).toBeDefined();
      const payload = JSON.parse(row!.payload as string);
      expect(payload.producer).toBe('JavaFactorComposite');
      expect(payload.methodologyFamily).toBe('FACTOR_MODEL');
      expect(payload.direction).toBe('BUY');
      expect(payload.confidence).toEqual({ value: 0.65, provenance: 'REAL_VALUE' });
      expect(row!.symbol).toBe('AAPL');
    });

    it('still emits QUANT_EVIDENCE_PRODUCED even when the vote itself does not fire (e.g. ADVISORY_GATED) - reflects every evaluated decision, not only successful votes', async () => {
      const result = emitJavaQuantVoteIfEligible('AAPL', advisory({ gated: true }), 190);
      expect(result).toEqual({ emitted: false, reason: 'ADVISORY_GATED' });
      await flushObservabilityStore();

      expect(captured.find((r) => r.eventType === 'QUANT_EVIDENCE_PRODUCED')).toBeDefined();
    });

    it('does NOT emit QUANT_EVIDENCE_PRODUCED when the JavaFactorComposite Mission Control toggle is off (AGENT_DISABLED is never bypassed for observability) - confirms the disabled agent still does not vote AND does not produce evidence', async () => {
      setPipelineAgentEnabled('JavaFactorComposite', false);
      const result = emitJavaQuantVoteIfEligible('AAPL', advisory(), 190);
      expect(result).toEqual({ emitted: false, reason: 'AGENT_DISABLED' });
      await flushObservabilityStore();

      expect(captured.find((r) => r.eventType === 'QUANT_EVIDENCE_PRODUCED')).toBeUndefined();
    });

    it('leaves unsupported fields honestly NULL_NOT_SUPPORTED / NOT_YET_CALIBRATED in the emitted event - never silently filled', async () => {
      emitJavaQuantVoteIfEligible('AAPL', advisory(), 190);
      await flushObservabilityStore();

      const payload = JSON.parse(captured.find((r) => r.eventType === 'QUANT_EVIDENCE_PRODUCED')!.payload as string);
      expect(payload.predictedReturn).toEqual({ value: null, provenance: 'NULL_NOT_SUPPORTED' });
      expect(payload.normalizedScore).toEqual({ value: null, provenance: 'NULL_NOT_SUPPORTED' });
      expect(payload.estimatedTransactionCostBps).toEqual({ value: null, provenance: 'NULL_NOT_SUPPORTED' });
      expect(payload.costQuality).toBe('NOT_APPLICABLE');
      expect(payload.calibrationStatus).toBe('NOT_YET_CALIBRATED');
    });

    it('suppresses the event (no QUANT_EVIDENCE_PRODUCED row, no throw) when the mapped evidence contains a non-finite number', async () => {
      const { mapJavaFactorCompositeToQuantEvidence } = await import('../quant/quantEvidenceAdapters');
      const { emitQuantEvidenceObservability: realEmit } = await vi.importActual<typeof import('../observability/quantEvidenceEmitter')>('../observability/quantEvidenceEmitter');
      const evidence = mapJavaFactorCompositeToQuantEvidence(advisory());
      const poisoned = { ...evidence, rawScore: { value: Number.POSITIVE_INFINITY, provenance: 'REAL_VALUE' as const } };
      expect(() => realEmit('AAPL', poisoned as any)).not.toThrow();
      await flushObservabilityStore();

      expect(captured.find((r) => r.eventType === 'QUANT_EVIDENCE_PRODUCED')).toBeUndefined();
      expect(captured.find((r) => r.eventType === 'QUANT_EVIDENCE_VALIDATION_FAILED')).toBeDefined();
    });

    it('does NOT prevent the vote decision from completing normally when the observability path throws (the single most important guarantee of this milestone)', () => {
      vi.mocked(emitQuantEvidenceObservability).mockImplementationOnce(() => {
        throw new Error('forced observability failure');
      });
      const ideas: any[] = [];
      const onIdea = (p: any) => ideas.push(p);
      eventBus.subscribe(EVENTS.TRADE_IDEA_GENERATED, onIdea);
      try {
        expect(() => emitJavaQuantVoteIfEligible('AAPL', advisory(), 190)).not.toThrow();
        const result = emitJavaQuantVoteIfEligible('AAPL', advisory(), 190);
        expect(result).toEqual({ emitted: true, reason: 'EMITTED' });
      } finally {
        eventBus.unsubscribe(EVENTS.TRADE_IDEA_GENERATED, onIdea);
      }
    });
  });
});
