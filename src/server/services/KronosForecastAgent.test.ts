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
});
