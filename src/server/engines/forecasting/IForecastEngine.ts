export interface ForecastPrediction {
  symbol: string;
  timeframe: string;
  prediction: string;
  confidence: number;
  forecastHorizon: number;
  expectedMove: string;
  volatility: string;
  support: number;
  resistance: number;
  model: string;
  timestamp: string;
  predictedOHLC?: any[];
  marketStructure?: string;
  momentum?: string;
}

export interface IForecastEngine {
  name: string;
  initialize(): Promise<void>;
  predict(symbol: string, horizon: number, timeframe: string, ohlcvData: any[]): Promise<ForecastPrediction>;
  batchPredict(symbols: string[], horizon: number, timeframe: string, dataMap: Record<string, any[]>): Promise<ForecastPrediction[]>;
  getStatus(): any;
}
