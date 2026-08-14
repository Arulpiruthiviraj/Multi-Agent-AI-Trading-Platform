import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eventBus } from '../core/EventBus';
import { MarketDataCrossChecker, computeDivergencePct, DIVERGENCE_THRESHOLD_PCT } from './MarketDataCrossChecker';

describe('computeDivergencePct', () => {
  it('computes a real symmetric percentage difference relative to the Questrade price', () => {
    expect(computeDivergencePct(100, 100)).toBe(0);
    expect(computeDivergencePct(101, 100)).toBeCloseTo(1, 5);
    expect(computeDivergencePct(99, 100)).toBeCloseTo(1, 5);
  });
});

describe('MarketDataCrossChecker.runCheck', () => {
  let emitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    emitSpy = vi.spyOn(eventBus, 'emit');
  });

  afterEach(() => {
    emitSpy.mockRestore();
  });

  it('idles when no Questrade-like source is registered', async () => {
    const checker = new MarketDataCrossChecker(() => undefined, () => ['AAPL'], () => 150);
    await checker.runCheck();
    expect(emitSpy).not.toHaveBeenCalledWith('MARKET_DATA_SOURCE_DISCREPANCY', expect.anything());
  });

  it('idles when the source reports Offline health', async () => {
    const source = { health: vi.fn(async () => 'Offline'), getQuote: vi.fn() };
    const checker = new MarketDataCrossChecker(() => source, () => ['AAPL'], () => 150);
    await checker.runCheck();
    expect(source.getQuote).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalledWith('MARKET_DATA_SOURCE_DISCREPANCY', expect.anything());
  });

  it('skips a symbol with no live Alpaca price yet, without ever calling Questrade for it', async () => {
    const source = { health: vi.fn(async () => 'Healthy'), getQuote: vi.fn() };
    const checker = new MarketDataCrossChecker(() => source, () => ['AAPL'], () => null);
    await checker.runCheck();
    expect(source.getQuote).not.toHaveBeenCalled();
  });

  it('emits a real discrepancy event when prices diverge beyond the threshold', async () => {
    const source = { health: vi.fn(async () => 'Healthy'), getQuote: vi.fn(async () => ({ last: 100 })) };
    const checker = new MarketDataCrossChecker(() => source, () => ['AAPL'], () => 103); // >0.5% divergence
    await checker.runCheck();
    expect(emitSpy).toHaveBeenCalledWith('MARKET_DATA_SOURCE_DISCREPANCY', expect.objectContaining({
      symbol: 'AAPL',
      alpacaPrice: 103,
      questradePrice: 100,
    }));
  });

  it('does not emit when prices agree within the threshold', async () => {
    const source = { health: vi.fn(async () => 'Healthy'), getQuote: vi.fn(async () => ({ last: 100 })) };
    const checker = new MarketDataCrossChecker(() => source, () => ['AAPL'], () => 100.1); // well under threshold
    await checker.runCheck();
    expect(emitSpy).not.toHaveBeenCalledWith('MARKET_DATA_SOURCE_DISCREPANCY', expect.anything());
  });

  it('skips a symbol whose Questrade quote resolves to a falsy/zero price rather than dividing by zero', async () => {
    const source = { health: vi.fn(async () => 'Healthy'), getQuote: vi.fn(async () => ({ last: 0 })) };
    const checker = new MarketDataCrossChecker(() => source, () => ['AAPL'], () => 100);
    await expect(checker.runCheck()).resolves.not.toThrow();
    expect(emitSpy).not.toHaveBeenCalledWith('MARKET_DATA_SOURCE_DISCREPANCY', expect.anything());
  });

  it('continues checking remaining symbols when one symbol\'s Questrade quote throws', async () => {
    const source = {
      health: vi.fn(async () => 'Healthy'),
      getQuote: vi.fn(async (symbol: string) => {
        if (symbol === 'BROKEN') throw new Error('Questrade API Error (500): boom');
        return { last: 200 };
      }),
    };
    const checker = new MarketDataCrossChecker(() => source, () => ['BROKEN', 'AAPL'], () => 206); // AAPL: >0.5% divergence
    await expect(checker.runCheck()).resolves.not.toThrow();
    expect(emitSpy).toHaveBeenCalledWith('MARKET_DATA_SOURCE_DISCREPANCY', expect.objectContaining({ symbol: 'AAPL' }));
  });

  it('DIVERGENCE_THRESHOLD_PCT is a real, positive, sub-single-digit-percent threshold', () => {
    expect(DIVERGENCE_THRESHOLD_PCT).toBeGreaterThan(0);
    expect(DIVERGENCE_THRESHOLD_PCT).toBeLessThan(5);
  });
});
