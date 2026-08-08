import { ForecastPrediction } from '../forecasting/IForecastEngine';

export class KronosPredictionCache {
  private cache: Map<string, ForecastPrediction> = new Map();

  private getKey(symbol: string, timeframe: string): string {
    return `${symbol}_${timeframe}`;
  }

  public get(symbol: string, timeframe: string): ForecastPrediction | undefined {
    return this.cache.get(this.getKey(symbol, timeframe));
  }

  public set(symbol: string, timeframe: string, prediction: ForecastPrediction) {
    this.cache.set(this.getKey(symbol, timeframe), prediction);
  }

  public getAll(): ForecastPrediction[] {
    return Array.from(this.cache.values());
  }
}
