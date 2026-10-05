import { ForecastPrediction } from '../forecasting/IForecastEngine';

export class KronosPredictionCache {
  private cache: Map<string, ForecastPrediction> = new Map();
  /**
   * FIFO cap: this cache is currently write-only (no reader calls get()/getAll() anywhere),
   * so without a bound it grows one entry per symbol x timeframe per forecast cadence for the
   * lifetime of the process. 500 entries is generous headroom; eviction is oldest-first.
   */
  private static readonly MAX_ENTRIES = 500;

  private getKey(symbol: string, timeframe: string): string {
    return `${symbol}_${timeframe}`;
  }

  public get(symbol: string, timeframe: string): ForecastPrediction | undefined {
    return this.cache.get(this.getKey(symbol, timeframe));
  }

  public set(symbol: string, timeframe: string, prediction: ForecastPrediction) {
    const key = this.getKey(symbol, timeframe);
    // Refresh recency on re-set so a hot symbol isn't evicted by cold ones.
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, prediction);
    while (this.cache.size > KronosPredictionCache.MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  public getAll(): ForecastPrediction[] {
    return Array.from(this.cache.values());
  }
}
