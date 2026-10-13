import { describe, it, expect, afterEach } from 'vitest';
import { marketDataWorker } from './MarketDataWorker';

/**
 * 2026-10-13: synthetic quotes carry simulated timestamps; every freshness decision must use the simulation clock or a held
 * position's price looks weeks old and PortfolioMonitor skips every protective exit (123/123 cycles in the canonical full-day run).
 */
describe('MarketDataWorker simulation clock seam', () => {
  const prev = process.env.SYNTHETIC_SIMULATION;
  afterEach(() => {
    marketDataWorker.setSimulationClock(null);
    if (prev === undefined) delete process.env.SYNTHETIC_SIMULATION; else process.env.SYNTHETIC_SIMULATION = prev;
  });

  it('refuses to install a substitute clock outside an isolated SYNTHETIC_SIMULATION process (cannot touch live trading)', () => {
    delete process.env.SYNTHETIC_SIMULATION;
    expect(() => marketDataWorker.setSimulationClock(() => 1)).toThrow(/SYNTHETIC_SIMULATION/);
    process.env.SYNTHETIC_SIMULATION = 'false';
    expect(() => marketDataWorker.setSimulationClock(() => 1)).toThrow(/SYNTHETIC_SIMULATION/);
    expect(() => marketDataWorker.setSimulationClock(null)).not.toThrow(); // clearing is always allowed
  });

  it('with the seam, price age is simulated-now minus the simulated tick time; without it, the real wall clock (production behavior unchanged)', () => {
    const sim = Date.parse('2026-09-15T14:05:00Z');
    marketDataWorker.cacheObservedQuote('SIMCLK', 100, sim);
    // production behavior: a 28-day-old tick is 28 days old
    const realAge = marketDataWorker.getLatestPriceAgeMs('SIMCLK')!;
    expect(realAge).toBeGreaterThan(20 * 86_400_000);
    process.env.SYNTHETIC_SIMULATION = 'true';
    marketDataWorker.setSimulationClock(() => sim + 30_000);
    expect(marketDataWorker.getLatestPriceAgeMs('SIMCLK')).toBe(30_000);
    marketDataWorker.setSimulationClock(() => sim + 7 * 60_000);
    expect(marketDataWorker.getLatestPriceAgeMs('SIMCLK')).toBe(7 * 60_000); // simulated time advances; staleness is still detected
    marketDataWorker.setSimulationClock(null);
    expect(marketDataWorker.getLatestPriceAgeMs('SIMCLK')!).toBeGreaterThan(20 * 86_400_000);
  });
});
