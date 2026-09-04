import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { emitTradeIdea, publish, noteFailure, noteGated, noteSuccess } = vi.hoisted(() => ({
  emitTradeIdea: vi.fn(),
  publish: vi.fn(),
  noteFailure: vi.fn(),
  noteGated: vi.fn(),
  noteSuccess: vi.fn(),
}));

vi.mock('../core/EventBus', () => ({
  eventBus: { emitTradeIdea, publish, subscribe: vi.fn(), unsubscribe: vi.fn() },
}));

const ideaGenEnabled = vi.hoisted(() => ({ value: true }));
vi.mock('../core/ideaGenerationGate', () => ({
  isLiveIdeaGenerationEnabled: () => ideaGenEnabled.value,
}));

vi.mock('../core/pipelineAgentGate', () => ({
  isPipelineAgentEnabled: () => true,
}));

vi.mock('../core/pipelineAgentHealth', () => ({
  notePipelineAgentTick: vi.fn(),
  notePipelineAgentGated: noteGated,
  notePipelineAgentSuccess: noteSuccess,
  notePipelineAgentFailure: noteFailure,
}));

vi.mock('../config/quantThresholds', () => ({
  quantThresholds: {
    kronosMinHistory: 3,
    kronosMaxHistory: 50,
    kronosHorizon: 5,
    kronosTimeframe: '1m',
    kronosNeutralBandPct: 0.001,
  },
}));

vi.mock('../config/runtimeIntervals', () => ({
  runtimeIntervals: { kronosPredictionCooldownMs: 0, kronosHttpTimeoutMs: 1000, kronosRecheckMs: 30_000 },
}));

const predict = vi.fn();
const getStatus = vi.fn(() => ({ isAvailable: false }));

vi.mock('../engines/kronos/KronosEngine', () => ({
  kronosEngine: {
    getStatus: () => getStatus(),
    predict: (...args: any[]) => predict(...args),
  },
}));

const oodGateEnabled = vi.hoisted(() => ({ value: false }));
vi.mock('../config/kronosDissimilarityGate', () => ({
  isKronosDissimilarityGateEnabled: () => oodGateEnabled.value,
}));

const { assessDissimilarityMock } = vi.hoisted(() => ({ assessDissimilarityMock: vi.fn() }));
vi.mock('../quant/KronosDissimilarityGate', () => ({
  computeInputFeatures: (closes: number[]) => (closes.length >= 5 ? { realizedVolatility: 0.01, meanAbsReturn: 0.005, rangeRatio: 0.02 } : null),
  assessDissimilarity: (...args: any[]) => assessDissimilarityMock(...args),
  getCachedKronosReferenceStats: () => ({ count: 100, mean: {}, stdev: {} }),
  isKronosReferenceStatsCacheStale: () => false,
  refreshKronosReferenceStats: vi.fn(),
}));

import { KronosForecastAgent } from './KronosForecastAgent';
import { EVENTS } from '../core/eventNames';

describe('KronosForecastAgent Chronos unavailable fail-closed', () => {
  beforeEach(() => {
    emitTradeIdea.mockClear();
    publish.mockClear();
    noteFailure.mockClear();
    noteGated.mockClear();
    noteSuccess.mockClear();
    predict.mockReset();
    getStatus.mockReturnValue({ isAvailable: false });
    ideaGenEnabled.value = true;
    oodGateEnabled.value = false;
    assessDissimilarityMock.mockReset();
    assessDissimilarityMock.mockReturnValue({ status: 'IN_DISTRIBUTION', maxAbsZ: 0.5, perFeatureZ: {}, referenceSampleSize: 100 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not emitTradeIdea when Chronos /health is unavailable — publishes KRONOS_UNAVAILABLE telemetry only', async () => {
    const agent = new KronosForecastAgent();
    for (let i = 0; i < 5; i++) {
      await (agent as any).onTick({ symbol: 'AAPL', price: 100 + i });
    }

    expect(predict).not.toHaveBeenCalled();
    expect(emitTradeIdea).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(
      EVENTS.KRONOS_UNAVAILABLE,
      expect.objectContaining({ symbol: 'AAPL', side: 'HOLD', confidence: 0, agent: 'KronosEngine' }),
    );
  });

  it('does not emitTradeIdea when forecast call fails — marks path fail-closed with telemetry', async () => {
    getStatus.mockReturnValue({ isAvailable: true });
    predict.mockRejectedValue(new Error('KRONOS_UNAVAILABLE: local inference service not reachable'));

    const agent = new KronosForecastAgent();
    for (let i = 0; i < 5; i++) {
      await (agent as any).onTick({ symbol: 'MSFT', price: 200 + i });
    }

    expect(predict).toHaveBeenCalled();
    expect(emitTradeIdea).not.toHaveBeenCalled();
    expect(noteFailure).toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(
      EVENTS.KRONOS_UNAVAILABLE,
      expect.objectContaining({ symbol: 'MSFT', side: 'HOLD', confidence: 0 }),
    );
  });

  it('emits a real BUY idea only after a successful Chronos forecast while available and idea gen enabled', async () => {
    getStatus.mockReturnValue({ isAvailable: true });
    predict.mockResolvedValue({
      symbol: 'GOOG',
      prediction: 'BUY',
      confidence: 0.82,
      expectedMove: '+1.2%',
      forecastHorizon: 5,
      support: 100,
      resistance: 110,
    });

    const agent = new KronosForecastAgent();
    (agent as any).priceHistory.GOOG = [150, 151, 152];
    await (agent as any).onTick({ symbol: 'GOOG', price: 154 });

    expect(emitTradeIdea).toHaveBeenCalledTimes(1);
    expect(emitTradeIdea.mock.calls[0][0]).toMatchObject({
      symbol: 'GOOG',
      side: 'BUY',
      agent: 'KronosEngine',
      confidence: 0.82,
    });
  });

  it('still calls Chronos /forecast when Autobot idea generation is off — but never emitTradeIdea', async () => {
    ideaGenEnabled.value = false;
    getStatus.mockReturnValue({ isAvailable: true });
    predict.mockResolvedValue({
      symbol: 'NVDA',
      prediction: 'SELL',
      confidence: 0.7,
      expectedMove: '-0.8%',
      forecastHorizon: 5,
      support: 100,
      resistance: 110,
    });

    const agent = new KronosForecastAgent();
    (agent as any).priceHistory.NVDA = [200, 201, 202];
    await (agent as any).onTick({ symbol: 'NVDA', price: 199 });

    expect(predict).toHaveBeenCalled();
    expect(emitTradeIdea).not.toHaveBeenCalled();
    expect(noteGated).toHaveBeenCalled();
    expect(noteSuccess).toHaveBeenCalled();
  });

  it('buffers ticks and forecasts even before Autobot arming (research path)', async () => {
    ideaGenEnabled.value = false;
    getStatus.mockReturnValue({ isAvailable: true });
    predict.mockResolvedValue({
      symbol: 'SPY',
      prediction: 'HOLD',
      confidence: 0.4,
      expectedMove: '0.00%',
      forecastHorizon: 5,
      support: 400,
      resistance: 401,
    });

    const agent = new KronosForecastAgent();
    for (let i = 0; i < 4; i++) {
      await (agent as any).onTick({ symbol: 'SPY', price: 400 + i * 0.1 });
    }

    expect(predict).toHaveBeenCalled();
    expect(emitTradeIdea).not.toHaveBeenCalled();
  });

  it('per-symbol timeout fails closed for that forecast only — other symbols still call Chronos when available', async () => {
    getStatus.mockReturnValue({ isAvailable: true });
    predict
      .mockRejectedValueOnce(new Error('KRONOS_UNAVAILABLE: ... (TimeoutError)'))
      .mockResolvedValueOnce({
        symbol: 'QQQ',
        prediction: 'BUY',
        confidence: 0.81,
        expectedMove: '+0.5%',
        forecastHorizon: 5,
        support: 400,
        resistance: 410,
      });

    const agent = new KronosForecastAgent();
    (agent as any).priceHistory.AAPL = [100, 101, 102];
    (agent as any).priceHistory.QQQ = [400, 401, 402];

    await (agent as any).onTick({ symbol: 'AAPL', price: 103 });
    expect(emitTradeIdea).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(
      EVENTS.KRONOS_UNAVAILABLE,
      expect.objectContaining({ symbol: 'AAPL', confidence: 0 }),
    );

    // Global availability stayed true (engine no longer latches on timeout) → QQQ still forecasts.
    await (agent as any).onTick({ symbol: 'QQQ', price: 403 });
    expect(predict).toHaveBeenCalledTimes(2);
    expect(emitTradeIdea).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'QQQ', side: 'BUY' }));
  });

  describe('Model-trust / dissimilarity gate (2026-09-04)', () => {
    it('is dormant by default - never calls assessDissimilarity and still emits ideas normally when KRONOS_OOD_GATE_ENABLED is off', async () => {
      getStatus.mockReturnValue({ isAvailable: true });
      predict.mockResolvedValue({
        symbol: 'AMD', prediction: 'BUY', confidence: 0.75, expectedMove: '+1.0%',
        forecastHorizon: 5, support: 100, resistance: 110,
      });

      const agent = new KronosForecastAgent();
      (agent as any).priceHistory.AMD = [100, 101, 102, 103, 104];
      await (agent as any).onTick({ symbol: 'AMD', price: 105 });

      expect(assessDissimilarityMock).not.toHaveBeenCalled();
      expect(emitTradeIdea).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'AMD', side: 'BUY' }));
    });

    it('rejects the live idea (never emitTradeIdea) and publishes KRONOS_OOD_REJECTED when the gate is enabled and the input is NOVEL - independent of a high model confidence', async () => {
      oodGateEnabled.value = true;
      assessDissimilarityMock.mockReturnValue({ status: 'NOVEL', maxAbsZ: 6.2, perFeatureZ: { realizedVolatility: 6.2 }, referenceSampleSize: 100 });
      getStatus.mockReturnValue({ isAvailable: true });
      predict.mockResolvedValue({
        // Deliberately high confidence - proves OOD rejection is not overridden by it.
        symbol: 'CRM', prediction: 'SELL', confidence: 0.91, expectedMove: '-2.0%',
        forecastHorizon: 5, support: 90, resistance: 95,
      });

      const agent = new KronosForecastAgent();
      (agent as any).priceHistory.CRM = [200, 201, 202, 203, 204];
      await (agent as any).onTick({ symbol: 'CRM', price: 205 });

      expect(assessDissimilarityMock).toHaveBeenCalled();
      expect(emitTradeIdea).not.toHaveBeenCalled();
      expect(publish).toHaveBeenCalledWith(
        EVENTS.KRONOS_OOD_REJECTED,
        expect.objectContaining({ symbol: 'CRM', side: 'SELL', confidence: 0.91, maxAbsZ: 6.2 }),
      );
      expect(noteGated).toHaveBeenCalled();
    });

    it('still emits the idea when the gate is enabled but the input is IN_DISTRIBUTION', async () => {
      oodGateEnabled.value = true;
      assessDissimilarityMock.mockReturnValue({ status: 'IN_DISTRIBUTION', maxAbsZ: 0.8, perFeatureZ: {}, referenceSampleSize: 100 });
      getStatus.mockReturnValue({ isAvailable: true });
      predict.mockResolvedValue({
        symbol: 'IBM', prediction: 'BUY', confidence: 0.6, expectedMove: '+0.5%',
        forecastHorizon: 5, support: 140, resistance: 150,
      });

      const agent = new KronosForecastAgent();
      (agent as any).priceHistory.IBM = [140, 141, 142, 143, 144];
      await (agent as any).onTick({ symbol: 'IBM', price: 145 });

      expect(assessDissimilarityMock).toHaveBeenCalled();
      expect(emitTradeIdea).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'IBM', side: 'BUY' }));
      expect(publish).not.toHaveBeenCalledWith(EVENTS.KRONOS_OOD_REJECTED, expect.anything());
    });

    it('treats an insufficient-reference-data assessment as safe to emit (not enough evidence to reject, never fabricated as NOVEL)', async () => {
      oodGateEnabled.value = true;
      assessDissimilarityMock.mockReturnValue({ status: 'INSUFFICIENT_REFERENCE_DATA', maxAbsZ: null, perFeatureZ: null, referenceSampleSize: 3 });
      getStatus.mockReturnValue({ isAvailable: true });
      predict.mockResolvedValue({
        symbol: 'ORCL', prediction: 'BUY', confidence: 0.65, expectedMove: '+0.6%',
        forecastHorizon: 5, support: 100, resistance: 110,
      });

      const agent = new KronosForecastAgent();
      (agent as any).priceHistory.ORCL = [100, 101, 102, 103, 104];
      await (agent as any).onTick({ symbol: 'ORCL', price: 105 });

      expect(emitTradeIdea).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'ORCL', side: 'BUY' }));
    });
  });
});
