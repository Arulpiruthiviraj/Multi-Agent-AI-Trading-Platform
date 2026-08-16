/**
 * ==========================================================
 * Module: KronosInference
 *
 * Purpose:
 * Calls the persistent local Chronos inference service (scripts/local_ai_service.py,
 * `npm run ai:serve`) for real numerical time-series forecasts. That service loads
 * amazon/chronos-t5-mini once and keeps it resident in memory; this class is just the
 * HTTP client for it - there is no in-process Python/PyTorch here.
 * ==========================================================
 */
import { ForecastPrediction } from '../forecasting/IForecastEngine';
import { preferIpv4Loopback } from '../../ai/preferIpv4Loopback';
import { quantThresholds } from '../../config/quantThresholds';
import { runtimeIntervals } from '../../config/runtimeIntervals';

const SERVICE_URL = preferIpv4Loopback(process.env.LOCAL_AI_SERVICE_URL || 'http://127.0.0.1:8008');

// A forecast within this band of the current price is treated as noise, not a directional
// call - avoids flooding ChiefTraderAgent with BUY/SELL ideas on sub-tenth-of-a-percent wobble.
const NEUTRAL_BAND_PCT = quantThresholds.kronosNeutralBandPct;

interface ChronosForecastResponse {
  model: string;
  low: number[];
  median: number[];
  high: number[];
}

async function callForecastService(prices: number[], horizon: number): Promise<ChronosForecastResponse> {
  let res: Response;
  try {
    res = await fetch(`${SERVICE_URL}/forecast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prices, horizon }),
      signal: AbortSignal.timeout(runtimeIntervals.kronosHttpTimeoutMs),
    });
  } catch (e: any) {
    throw new Error(`KRONOS_UNAVAILABLE: local inference service not reachable at ${SERVICE_URL} (${e.message}). Run 'npm run ai:serve'.`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`KRONOS_UNAVAILABLE: local inference service returned ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Accepts either plain closing prices or candle-like objects (close/price field) - keeps this
// usable regardless of whether a caller has full OHLCV bars or just a rolling price series.
function toCloses(ohlcvData: any[]): number[] {
  return ohlcvData
    .map((c) => (typeof c === 'number' ? c : c?.close ?? c?.price))
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

function buildPrediction(symbol: string, timeframe: string, horizon: number, lastPrice: number, forecast: ChronosForecastResponse): ForecastPrediction {
  const medianEnd = forecast.median[forecast.median.length - 1];
  const lowEnd = forecast.low[forecast.low.length - 1];
  const highEnd = forecast.high[forecast.high.length - 1];

  const pctChange = (medianEnd - lastPrice) / lastPrice;
  const direction = pctChange > NEUTRAL_BAND_PCT ? 'BUY' : pctChange < -NEUTRAL_BAND_PCT ? 'SELL' : 'HOLD';

  // Confidence from how tight the sampled quantile spread is relative to price - a forecast
  // where the 10th/90th percentile samples barely disagree is a more confident call than one
  // where they're far apart. Clamped to [0.3, 0.85]: this is a small model on a short context,
  // never claim near-certainty from it.
  const relativeSpread = Math.abs(highEnd - lowEnd) / Math.abs(lastPrice);
  const confidence = Math.max(0.3, Math.min(0.85, 1 - relativeSpread * 4));

  return {
    symbol,
    timeframe,
    prediction: direction,
    confidence: Number(confidence.toFixed(3)),
    forecastHorizon: horizon,
    expectedMove: `${(pctChange * 100).toFixed(2)}%`,
    volatility: `${(relativeSpread * 100).toFixed(2)}%`,
    support: Number(lowEnd.toFixed(4)),
    resistance: Number(highEnd.toFixed(4)),
    model: `${forecast.model} (local)`,
    timestamp: new Date().toISOString(),
    predictedOHLC: forecast.median.map((close) => ({ close })),
    momentum: direction === 'BUY' ? 'bullish' : direction === 'SELL' ? 'bearish' : 'neutral',
  };
}

export class KronosInference {
  constructor() {}

  public prepareTokens(ohlcvData: any[]): any {
    return {
      numCandles: ohlcvData?.length || 0,
      isTokenized: false,
    };
  }

  public async predict(symbol: string, horizon: number, timeframe: string, ohlcvData: any[]): Promise<ForecastPrediction> {
    const closes = toCloses(ohlcvData);
    if (closes.length < 5) {
      throw new Error(`KRONOS_UNAVAILABLE: need at least 5 price points, got ${closes.length}.`);
    }
    const forecast = await callForecastService(closes, horizon);
    return buildPrediction(symbol, timeframe, horizon, closes[closes.length - 1], forecast);
  }

  public async batchPredict(symbols: string[], horizon: number, timeframe: string, dataMap: Record<string, any[]>): Promise<ForecastPrediction[]> {
    const results: ForecastPrediction[] = [];
    for (const symbol of symbols) {
      try {
        results.push(await this.predict(symbol, horizon, timeframe, dataMap[symbol] || []));
      } catch (e) {
        // One symbol's failure (e.g. too little history) shouldn't sink the whole batch.
      }
    }
    return results;
  }
}
