import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./MissedOpportunityDetector', () => ({
  getPendingEvaluations: vi.fn(),
  evaluateAgainstPriceSeries: vi.fn(),
  persistEvaluation: vi.fn(),
}));

vi.mock('../engines/backtest/HistoricalDataGateway', () => ({
  historicalDataGateway: {
    getBars: vi.fn(),
    ensureBars: vi.fn(),
  },
}));

describe('MissedOpportunityEvaluator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('evaluates a pending record using real bars and persists the result (closes the "592 rows never evaluated" gap)', async () => {
    const { getPendingEvaluations, evaluateAgainstPriceSeries, persistEvaluation } = await import('./MissedOpportunityDetector');
    const { historicalDataGateway } = await import('../engines/backtest/HistoricalDataGateway');
    const { MissedOpportunityEvaluator } = await import('./MissedOpportunityEvaluator');

    const detectedAt = new Date('2026-09-08T14:00:00.000Z').toISOString();
    (getPendingEvaluations as any).mockResolvedValue([
      { id: 'miss-1', symbol: 'NVDA', detectedAt, evaluationHorizonMinutes: 60, priceAtDetection: 120 },
    ]);
    (historicalDataGateway.getBars as any).mockResolvedValue([
      { timestamp: 1, open: 1, high: 1, low: 1, close: 120, volume: 1 },
      { timestamp: 2, open: 1, high: 1, low: 1, close: 126, volume: 1 },
    ]);
    (evaluateAgainstPriceSeries as any).mockReturnValue({
      priceAtEvaluation: 126, maxFavorableExcursionPct: 5, maxAdverseExcursionPct: -1,
    });

    const evaluator = new MissedOpportunityEvaluator();
    await evaluator.evaluatePending(new Date('2026-09-08T15:05:00.000Z'));

    expect(historicalDataGateway.ensureBars).not.toHaveBeenCalled(); // enough bars on first try
    expect(evaluateAgainstPriceSeries).toHaveBeenCalledWith(120, [120, 126]);
    expect(persistEvaluation).toHaveBeenCalledWith('miss-1', {
      priceAtEvaluation: 126, maxFavorableExcursionPct: 5, maxAdverseExcursionPct: -1,
    }, expect.any(Date));
  });

  it('falls back to the first real bar close when the record has no stored priceAtDetection (legacy pre-fix rows)', async () => {
    const { getPendingEvaluations, evaluateAgainstPriceSeries, persistEvaluation } = await import('./MissedOpportunityDetector');
    const { historicalDataGateway } = await import('../engines/backtest/HistoricalDataGateway');
    const { MissedOpportunityEvaluator } = await import('./MissedOpportunityEvaluator');

    (getPendingEvaluations as any).mockResolvedValue([
      { id: 'miss-legacy', symbol: 'RBLX', detectedAt: new Date().toISOString(), evaluationHorizonMinutes: 60, priceAtDetection: null },
    ]);
    (historicalDataGateway.getBars as any).mockResolvedValue([
      { timestamp: 1, open: 1, high: 1, low: 1, close: 44.5, volume: 1 },
      { timestamp: 2, open: 1, high: 1, low: 1, close: 43.0, volume: 1 },
    ]);
    (evaluateAgainstPriceSeries as any).mockReturnValue({
      priceAtEvaluation: 43.0, maxFavorableExcursionPct: 0, maxAdverseExcursionPct: -3.4,
    });

    const evaluator = new MissedOpportunityEvaluator();
    await evaluator.evaluatePending();

    expect(evaluateAgainstPriceSeries).toHaveBeenCalledWith(44.5, [44.5, 43.0]);
    expect(persistEvaluation).toHaveBeenCalled();
  });

  it('never fabricates a result: leaves the record PENDING when fewer than 2 real bars exist even after ensureBars', async () => {
    const { getPendingEvaluations, evaluateAgainstPriceSeries, persistEvaluation } = await import('./MissedOpportunityDetector');
    const { historicalDataGateway } = await import('../engines/backtest/HistoricalDataGateway');
    const { MissedOpportunityEvaluator } = await import('./MissedOpportunityEvaluator');

    (getPendingEvaluations as any).mockResolvedValue([
      { id: 'miss-nodata', symbol: 'ZZZZ', detectedAt: new Date().toISOString(), evaluationHorizonMinutes: 60, priceAtDetection: 10 },
    ]);
    (historicalDataGateway.getBars as any).mockResolvedValue([]);
    (historicalDataGateway.ensureBars as any).mockResolvedValue(undefined);

    const evaluator = new MissedOpportunityEvaluator();
    await evaluator.evaluatePending();

    expect(historicalDataGateway.ensureBars).toHaveBeenCalled();
    expect(evaluateAgainstPriceSeries).not.toHaveBeenCalled();
    expect(persistEvaluation).not.toHaveBeenCalled();
  });

  it('one symbol failing does not block evaluation of the others in the same cycle', async () => {
    const { getPendingEvaluations, evaluateAgainstPriceSeries, persistEvaluation } = await import('./MissedOpportunityDetector');
    const { historicalDataGateway } = await import('../engines/backtest/HistoricalDataGateway');
    const { MissedOpportunityEvaluator } = await import('./MissedOpportunityEvaluator');

    (getPendingEvaluations as any).mockResolvedValue([
      { id: 'miss-bad', symbol: 'BAD', detectedAt: new Date().toISOString(), evaluationHorizonMinutes: 60, priceAtDetection: 10 },
      { id: 'miss-good', symbol: 'GOOD', detectedAt: new Date().toISOString(), evaluationHorizonMinutes: 60, priceAtDetection: 10 },
    ]);
    (historicalDataGateway.getBars as any).mockImplementation(async (symbol: string) => {
      if (symbol === 'BAD') throw new Error('gateway error');
      return [
        { timestamp: 1, open: 1, high: 1, low: 1, close: 10, volume: 1 },
        { timestamp: 2, open: 1, high: 1, low: 1, close: 11, volume: 1 },
      ];
    });
    (evaluateAgainstPriceSeries as any).mockReturnValue({ priceAtEvaluation: 11, maxFavorableExcursionPct: 10, maxAdverseExcursionPct: 0 });

    const evaluator = new MissedOpportunityEvaluator();
    await evaluator.evaluatePending();

    expect(persistEvaluation).toHaveBeenCalledTimes(1);
    expect(persistEvaluation).toHaveBeenCalledWith('miss-good', expect.anything(), expect.any(Date));
  });

  it('start() schedules on the configured interval and stop() cancels it (mirrors PredictionOutcomeEvaluator\'s own pattern)', async () => {
    vi.useFakeTimers();
    const { getPendingEvaluations } = await import('./MissedOpportunityDetector');
    (getPendingEvaluations as any).mockResolvedValue([]);
    const { MissedOpportunityEvaluator } = await import('./MissedOpportunityEvaluator');
    const { continuousIntelligence } = await import('../config/continuousIntelligence');

    const evaluator = new MissedOpportunityEvaluator();
    evaluator.start();
    expect(getPendingEvaluations).toHaveBeenCalledTimes(1); // immediate first run

    await vi.advanceTimersByTimeAsync(continuousIntelligence.missedOpportunityEvaluationIntervalMs);
    expect(getPendingEvaluations).toHaveBeenCalledTimes(2);

    evaluator.stop();
    await vi.advanceTimersByTimeAsync(continuousIntelligence.missedOpportunityEvaluationIntervalMs * 3);
    expect(getPendingEvaluations).toHaveBeenCalledTimes(2); // no further calls after stop()
  });
});
