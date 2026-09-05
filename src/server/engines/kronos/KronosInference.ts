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
import { resolveLocalAiServiceUrl } from '../../ai/preferIpv4Loopback';
import { quantThresholds } from '../../config/quantThresholds';
import { runtimeIntervals } from '../../config/runtimeIntervals';

const SERVICE_URL = resolveLocalAiServiceUrl();

// A forecast within this band of the current price is treated as noise, not a directional
// call - avoids flooding ChiefTraderAgent with BUY/SELL ideas on sub-tenth-of-a-percent wobble.
const NEUTRAL_BAND_PCT = quantThresholds.kronosNeutralBandPct;

export interface ChronosForecastResponse {
  model: string;
  low: number[];
  median: number[];
  high: number[];
  latencyMs?: number;
  device?: string;
}

/**
 * Serialize / limit concurrent Chronos /forecast HTTP calls. CPU Chronos under multi-symbol
 * MARKET_DATA fan-out otherwise timeout-storms. Fail-closed per caller; queue waits its turn.
 */
export class ChronosForecastGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const limit = Math.max(1, this.maxConcurrent);
    if (this.active >= limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next();
    }
  }

  /** Test helper — in-flight + queued depth. */
  snapshot(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.waiters.length };
  }
}

export const chronosForecastGate = new ChronosForecastGate(runtimeIntervals.kronosForecastMaxConcurrent);

async function callForecastService(prices: number[], horizon: number): Promise<ChronosForecastResponse> {
  return chronosForecastGate.run(async () => {
    const started = Date.now();
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
    const json = await res.json() as ChronosForecastResponse;
    if (typeof json.latencyMs !== 'number' || !Number.isFinite(json.latencyMs)) {
      json.latencyMs = Date.now() - started;
    }
    return json;
  });
}

// Accepts either plain closing prices or candle-like objects (close/price field) - keeps this
// usable regardless of whether a caller has full OHLCV bars or just a rolling price series.
function toCloses(ohlcvData: any[]): number[] {
  return ohlcvData
    .map((c) => (typeof c === 'number' ? c : c?.close ?? c?.price))
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

/**
 * Confidence from how tight the sampled quantile spread is relative to price - a forecast where
 * the 10th/90th percentile samples barely disagree is a more confident call than one where
 * they're far apart. Exported for direct unit testing of the calibration below.
 *
 * 2026-09-04 recalibration: the original multiplier (4) assumed relativeSpread would commonly
 * range wide enough to use the full [floor, ceiling] band. Live evidence contradicted that - a
 * 3,000-row sample of real kronos_predictions rows showed relativeSpread at p50/p25/p10/p5 = 0%,
 * p90 = 0.73%, p99 = 2.24%, and correspondingly confidence sat at exactly the 0.85 ceiling on
 * 2,999/3,000 real predictions. With multiplier=4, even the p99 spread (0.0224) only pulls
 * confidence to ~0.91, still clamped to the ceiling - the entire real distribution was saturating
 * it. kronosConfidenceSpreadMultiplier=25 was chosen so the measured p90 spread lands at ~0.82
 * (just under the ceiling) and the measured p99 spread lands at ~0.44 (well below it), so
 * confidence actually varies across the range Kronos really produces instead of reading a
 * constant value regardless of forecast tightness.
 *
 * This fixes a degenerate SIGNAL (a constant is strictly less informative than a real varying
 * one) - it does NOT establish that tighter spreads correlate with more accurate forecasts, and
 * it does NOT change KronosEngine's measured win rate. That remains a separate, unresolved
 * question (agent_performance_stats: Wilson lower bound ~0.48, i.e. not distinguishable from
 * chance) and this change makes no claim about it either way.
 */
export function computeKronosConfidence(relativeSpread: number): number {
  const floor = quantThresholds.kronosConfidenceFloor;
  const ceiling = quantThresholds.kronosConfidenceCeiling;
  const multiplier = quantThresholds.kronosConfidenceSpreadMultiplier;
  return Math.max(floor, Math.min(ceiling, 1 - relativeSpread * multiplier));
}

function buildPrediction(symbol: string, timeframe: string, horizon: number, lastPrice: number, forecast: ChronosForecastResponse): ForecastPrediction {
  const medianEnd = forecast.median[forecast.median.length - 1];
  const lowEnd = forecast.low[forecast.low.length - 1];
  const highEnd = forecast.high[forecast.high.length - 1];

  const pctChange = (medianEnd - lastPrice) / lastPrice;
  const direction = pctChange > NEUTRAL_BAND_PCT ? 'BUY' : pctChange < -NEUTRAL_BAND_PCT ? 'SELL' : 'HOLD';

  const relativeSpread = Math.abs(highEnd - lowEnd) / Math.abs(lastPrice);
  const confidence = computeKronosConfidence(relativeSpread);

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
    predictedOHLC: forecast.median.map((close, i) => ({
      close,
      low: forecast.low[i],
      high: forecast.high[i],
    })),
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

  public async predict(symbol: string, horizon: number, timeframe: string, ohlcvData: any[]): Promise<ForecastPrediction & { latencyMs?: number }> {
    const closes = toCloses(ohlcvData);
    if (closes.length < 5) {
      throw new Error(`KRONOS_UNAVAILABLE: need at least 5 price points, got ${closes.length}.`);
    }
    const forecast = await callForecastService(closes, horizon);
    const prediction = buildPrediction(symbol, timeframe, horizon, closes[closes.length - 1], forecast) as ForecastPrediction & { latencyMs?: number };
    prediction.latencyMs = forecast.latencyMs;
    return prediction;
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
