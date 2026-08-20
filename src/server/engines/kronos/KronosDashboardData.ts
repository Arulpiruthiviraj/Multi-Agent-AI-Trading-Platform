/**
 * Kronos dashboard aggregates: historical error metrics from prediction_outcomes +
 * latest forecast bands from kronos_predictions / agent_predictions.
 * Never fabricates numbers when no scored rows exist.
 */
import { db } from '../../db';
import { agentPredictions, kronosPredictions, predictionOutcomes } from '../../db/schema';
import { desc, eq } from 'drizzle-orm';
import { quantThresholds } from '../../config/quantThresholds';

export interface KronosHistoricalMetrics {
  directionalAccuracy: number | null;
  mae: number | null;
  rmse: number | null;
  mape: number | null;
  sampleSize: number;
  source: 'prediction_outcomes' | 'none';
  unavailableReason: string | null;
}

export interface KronosForecastSeriesPoint {
  step: number;
  median: number;
  low: number;
  high: number;
}

export interface KronosLatestForecast {
  symbol: string;
  available: boolean;
  prediction: string | null;
  confidence: number | null;
  expectedMove: string | null;
  volatility: string | null;
  support: number | null;
  resistance: number | null;
  timeframe: string | null;
  forecastHorizon: number | null;
  timestamp: string | null;
  model: string | null;
  series: KronosForecastSeriesPoint[];
  unavailableReason: string | null;
}

function parseExpectedMovePct(expectedMove: string | null | undefined): number | null {
  if (!expectedMove || typeof expectedMove !== 'string') return null;
  const m = expectedMove.trim().replace('%', '');
  const n = Number(m);
  return Number.isFinite(n) ? n / 100 : null;
}

function parseTrajectory(predictedOhlc: string | null | undefined): { median: number; low: number; high: number }[] {
  if (!predictedOhlc) return [];
  try {
    const raw = JSON.parse(predictedOhlc);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((c: any) => {
        if (typeof c === 'number' && Number.isFinite(c)) return { median: c, low: c, high: c };
        const median = Number(c?.close ?? c?.median);
        const low = Number(c?.low ?? median);
        const high = Number(c?.high ?? median);
        if (!Number.isFinite(median)) return null;
        return {
          median,
          low: Number.isFinite(low) ? low : median,
          high: Number.isFinite(high) ? high : median,
        };
      })
      .filter((x): x is { median: number; low: number; high: number } => x != null);
  } catch {
    return [];
  }
}

/**
 * Directional accuracy + price-level MAE/RMSE/MAPE from real prediction_outcomes joined to
 * Kronos forecasts. MAE here is mean absolute *price* error (not the schema's adverse-excursion
 * column). Returns null metrics with an honest reason when no scored directional rows exist.
 */
export async function getKronosHistoricalMetrics(): Promise<KronosHistoricalMetrics> {
  const kronosOutcomes = await db
    .select()
    .from(predictionOutcomes)
    .where(eq(predictionOutcomes.sourceTable, 'kronos_predictions'))
    .all();

  const agentKronosPreds = await db
    .select()
    .from(agentPredictions)
    .where(eq(agentPredictions.agentName, 'KronosEngine'))
    .all();
  const agentIds = new Set(agentKronosPreds.map((p) => p.id));
  const agentOutcomes = (
    await db
      .select()
      .from(predictionOutcomes)
      .where(eq(predictionOutcomes.sourceTable, 'agent_predictions'))
      .all()
  ).filter((o) => agentIds.has(o.predictionId));

  const outcomes = [...kronosOutcomes, ...agentOutcomes];
  const directional = outcomes.filter((o) => o.outcome === 'WIN' || o.outcome === 'LOSS');
  if (directional.length === 0) {
    return {
      directionalAccuracy: null,
      mae: null,
      rmse: null,
      mape: null,
      sampleSize: 0,
      source: 'none',
      unavailableReason: outcomes.length === 0
        ? 'No prediction_outcomes rows for Kronos yet. Forecasts must age past evaluationHorizonMs and have real bars before scoring.'
        : 'Only N_A / non-directional Kronos outcomes exist — directional accuracy needs scored BUY/SELL rows.',
    };
  }

  const wins = directional.filter((o) => o.outcome === 'WIN').length;
  const directionalAccuracy = wins / directional.length;

  // Price error metrics: prefer kronos_predictions.predicted OHLC vs outcome.actualPrice.
  const kronosById = new Map(
    (await db.select().from(kronosPredictions).all()).map((k) => [String(k.id), k]),
  );
  const agentById = new Map(agentKronosPreds.map((p) => [p.id, p]));

  const absErrors: number[] = [];
  const pctErrors: number[] = [];

  for (const o of directional) {
    if (o.actualPrice == null || !Number.isFinite(o.actualPrice) || o.actualPrice <= 0) continue;
    let predictedPrice: number | null = null;

    if (o.sourceTable === 'kronos_predictions') {
      const row = kronosById.get(o.predictionId);
      if (row) {
        const traj = parseTrajectory(row.predictedOhlc);
        if (traj.length > 0) predictedPrice = traj[traj.length - 1].median;
        if (predictedPrice == null && o.actualReturn != null) {
          // Reconstruct from expected move if trajectory missing: need entry ≈ actual/(1+ret)
          const entry = o.actualPrice / (1 + o.actualReturn);
          const move = parseExpectedMovePct(row.expectedMove);
          if (Number.isFinite(entry) && entry > 0 && move != null) {
            predictedPrice = entry * (1 + move);
          }
        }
      }
    } else {
      const row = agentById.get(o.predictionId);
      if (row?.reasoning) {
        try {
          const parsed = JSON.parse(row.reasoning);
          const traj = Array.isArray(parsed?.priceTrajectory) ? parsed.priceTrajectory : [];
          const last = traj[traj.length - 1];
          if (typeof last === 'number' && Number.isFinite(last)) predictedPrice = last;
          else if (parsed?.lastPrice != null && parsed?.expectedMove) {
            const move = parseExpectedMovePct(String(parsed.expectedMove));
            if (move != null && Number.isFinite(Number(parsed.lastPrice))) {
              predictedPrice = Number(parsed.lastPrice) * (1 + move);
            }
          }
        } catch { /* ignore */ }
      }
    }

    if (predictedPrice == null || !Number.isFinite(predictedPrice)) continue;
    const err = Math.abs(predictedPrice - o.actualPrice);
    absErrors.push(err);
    pctErrors.push(err / o.actualPrice);
  }

  const mae = absErrors.length > 0 ? absErrors.reduce((a, b) => a + b, 0) / absErrors.length : null;
  const rmse = absErrors.length > 0
    ? Math.sqrt(absErrors.reduce((a, b) => a + b * b, 0) / absErrors.length)
    : null;
  const mape = pctErrors.length > 0
    ? (pctErrors.reduce((a, b) => a + b, 0) / pctErrors.length) * 100
    : null;

  return {
    directionalAccuracy,
    mae,
    rmse,
    mape,
    sampleSize: directional.length,
    source: 'prediction_outcomes',
    unavailableReason: null,
  };
}

export async function getKronosLatestForecast(symbol?: string | null): Promise<KronosLatestForecast> {
  const wanted = symbol?.trim().toUpperCase() || null;

  let rows = await db.select().from(kronosPredictions).orderBy(desc(kronosPredictions.id)).limit(50).all();
  if (wanted) {
    rows = rows.filter((r) => r.symbol.toUpperCase() === wanted);
  }
  const row = rows[0];

  if (!row) {
    // Fallback: latest Kronos agent_predictions reasoning trajectory
    let agentRows = await db
      .select()
      .from(agentPredictions)
      .where(eq(agentPredictions.agentName, 'KronosEngine'))
      .orderBy(desc(agentPredictions.timestamp))
      .limit(50)
      .all();
    if (wanted) agentRows = agentRows.filter((r) => r.symbol.toUpperCase() === wanted);
    const ap = agentRows[0];
    if (!ap) {
      return {
        symbol: wanted || 'UNKNOWN',
        available: false,
        prediction: null,
        confidence: null,
        expectedMove: null,
        volatility: null,
        support: null,
        resistance: null,
        timeframe: quantThresholds.kronosTimeframe,
        forecastHorizon: quantThresholds.kronosHorizon,
        timestamp: null,
        model: null,
        series: [],
        unavailableReason: wanted
          ? `No Kronos forecast stored yet for ${wanted}. Needs Chronos :8008 healthy and ≥${quantThresholds.kronosMinHistory} ticks.`
          : `No Kronos forecasts stored yet. Needs Chronos :8008 healthy and ≥${quantThresholds.kronosMinHistory} ticks.`,
      };
    }
    let series: KronosForecastSeriesPoint[] = [];
    let support: number | null = null;
    let resistance: number | null = null;
    let expectedMove: string | null = null;
    let volatility: string | null = null;
    let timeframe: string | null = quantThresholds.kronosTimeframe;
    let forecastHorizon: number | null = quantThresholds.kronosHorizon;
    let model: string | null = null;
    try {
      const parsed = JSON.parse(ap.reasoning);
      const traj: number[] = Array.isArray(parsed?.priceTrajectory) ? parsed.priceTrajectory.filter((n: any) => typeof n === 'number') : [];
      series = traj.map((median, i) => ({ step: i + 1, median, low: median, high: median }));
      support = typeof parsed?.support === 'number' ? parsed.support : null;
      resistance = typeof parsed?.resistance === 'number' ? parsed.resistance : null;
      expectedMove = parsed?.expectedMove ?? null;
      volatility = parsed?.volatility ?? null;
      timeframe = parsed?.timeframe ?? timeframe;
      forecastHorizon = typeof parsed?.forecastHorizon === 'number' ? parsed.forecastHorizon : forecastHorizon;
      model = parsed?.model ?? null;
    } catch { /* ignore */ }
    return {
      symbol: ap.symbol,
      available: series.length > 0,
      prediction: ap.prediction,
      confidence: ap.confidence,
      expectedMove,
      volatility,
      support,
      resistance,
      timeframe,
      forecastHorizon,
      timestamp: ap.timestamp,
      model,
      series,
      unavailableReason: series.length > 0 ? null : 'Kronos agent_predictions row has no priceTrajectory.',
    };
  }

  const traj = parseTrajectory(row.predictedOhlc);
  const series: KronosForecastSeriesPoint[] = traj.map((t, i) => ({
    step: i + 1,
    median: t.median,
    low: t.low,
    high: t.high,
  }));

  return {
    symbol: row.symbol,
    available: series.length > 0,
    prediction: row.prediction,
    confidence: typeof row.confidence === 'number' ? row.confidence : Number(row.confidence),
    expectedMove: row.expectedMove,
    volatility: row.volatility,
    support: row.support,
    resistance: row.resistance,
    timeframe: row.timeframe,
    forecastHorizon: row.forecastHorizon,
    timestamp: row.timestamp,
    model: row.model,
    series,
    unavailableReason: series.length > 0 ? null : 'Latest kronos_predictions row has empty predicted_ohlc.',
  };
}
