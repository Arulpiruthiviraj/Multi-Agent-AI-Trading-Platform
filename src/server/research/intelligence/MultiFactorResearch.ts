/**
 * Multi-Factor Strategy (Phase 8). Combines existing, unmodified indicator computations
 * (computeMomentumFeatures, computeVolumeFeatures — quant/indicators/*, already live-used by
 * QuantSignalAgent) plus RegimeEngine's volatility/trend read into one transparent factor score.
 * No new indicator math is introduced. Value/quality factors are NOT computed here — real
 * fundamental data (P/E, growth, debt/equity) is thin/unreliable for much of the current universe
 * (see FundamentalAgent's own real 90%-zero-confidence rate) — this module reports them as
 * MISSING rather than substituting a fabricated score, per the explicit anti-fabrication rule.
 */
import type { Bar } from '../../engines/backtest/HistoricalDataGateway';
import { computeMomentumFeatures } from '../../quant/indicators/momentum';
import { computeVolumeFeatures } from '../../quant/indicators/volume';
import { classifyRegime } from '../../quant/RegimeEngine';
import { wrapResearchResult, ResearchResult, DataQualityMeta } from './types';
import { emitResearchEvent } from './researchEventLog';

export interface FactorObservation {
  factor: 'momentum' | 'trend' | 'volatility' | 'liquidity' | 'mean_reversion' | 'value' | 'quality';
  score: number | null; // -1..1, null when not computable
  source: string;
  timestamp: string;
  quality: 'GREEN' | 'YELLOW' | 'RED' | 'UNAVAILABLE';
  missing: boolean;
}

export interface MultiFactorAnalysis {
  factors: FactorObservation[];
  /** Mean of computable factor scores only — never imputes a missing factor as 0. */
  compositeScore: number | null;
  computableFactorCount: number;
}

function clamp(x: number, lo = -1, hi = 1): number {
  return Math.max(lo, Math.min(hi, x));
}

export function runMultiFactorResearch(opts: {
  symbol: string;
  bars: Bar[];
  traceId?: string;
}): ResearchResult<MultiFactorAnalysis> {
  const now = new Date().toISOString();
  const factors: FactorObservation[] = [];

  if (opts.bars.length >= 20) {
    const momentum = computeMomentumFeatures(opts.bars);
    factors.push({
      factor: 'momentum',
      score: clamp((momentum.rsi - 50) / 50),
      source: 'quant/indicators/momentum.ts (RSIEngine, reused)',
      timestamp: now,
      quality: 'GREEN',
      missing: false,
    });

    const volume = computeVolumeFeatures(opts.bars);
    factors.push({
      factor: 'liquidity',
      score: volume.relativeVolume != null ? clamp(volume.relativeVolume - 1, -1, 1) : null,
      source: 'quant/indicators/volume.ts (relativeVolume, reused)',
      timestamp: now,
      quality: volume.relativeVolume != null ? 'GREEN' : 'YELLOW',
      missing: volume.relativeVolume == null,
    });

    const regime = classifyRegime(opts.bars);
    factors.push({
      factor: 'trend',
      score: regime.insufficientData ? null : (regime.regime === 'BULLISH_TREND' ? regime.confidence : regime.regime === 'BEARISH_TREND' ? -regime.confidence : 0),
      source: 'quant/RegimeEngine.ts (classifyRegime, reused — same call the live QuantEngine makes)',
      timestamp: now,
      quality: regime.insufficientData ? 'YELLOW' : 'GREEN',
      missing: regime.insufficientData,
    });
    factors.push({
      factor: 'volatility',
      score: regime.insufficientData ? null : (regime.volatility === 'HIGH' ? -0.5 : regime.volatility === 'LOW' ? 0.5 : 0),
      source: 'quant/RegimeEngine.ts (classifyRegime.volatility, reused)',
      timestamp: now,
      quality: regime.insufficientData ? 'YELLOW' : 'GREEN',
      missing: regime.insufficientData,
    });

    const closes = opts.bars.map((b) => b.close);
    const sma20 = closes.slice(-20).reduce((s, v) => s + v, 0) / 20;
    const lastClose = closes[closes.length - 1];
    factors.push({
      factor: 'mean_reversion',
      score: clamp(-(lastClose - sma20) / sma20 * 5),
      source: 'SMA20 distance (computed here — not a new indicator engine, a direct arithmetic derivation of the existing close series)',
      timestamp: now,
      quality: 'GREEN',
      missing: false,
    });
  }

  // Real, explicit gap — never fabricated: no reliable per-symbol fundamental data source exists
  // for most of the current universe (FundamentalAgent's own 90%-zero-confidence real rate).
  factors.push({ factor: 'value', score: null, source: 'FundamentalAgent (AlphaVantage) — unreliable for most of the current universe', timestamp: now, quality: 'UNAVAILABLE', missing: true });
  factors.push({ factor: 'quality', score: null, source: 'No reliable quality-factor data source exists yet', timestamp: now, quality: 'UNAVAILABLE', missing: true });

  const computable = factors.filter((f) => f.score !== null);
  const compositeScore = computable.length ? computable.reduce((s, f) => s + (f.score as number), 0) / computable.length : null;

  const dataQuality: DataQualityMeta = {
    source: 'Composite of quant/indicators/* + RegimeEngine.ts (all reused, unmodified)',
    symbol: opts.symbol,
    timestamp: now,
    sampleSize: opts.bars.length,
    missingFields: factors.filter((f) => f.missing).map((f) => f.factor),
    staleness: opts.bars.length > 0 ? 'FRESH' : 'UNKNOWN',
    assumptions: ['value/quality factors intentionally left MISSING, not fabricated', 'compositeScore averages only computable factors'],
    quality: computable.length >= 3 ? 'GREEN' : computable.length > 0 ? 'YELLOW' : 'UNAVAILABLE',
  };

  const result = wrapResearchResult({
    capability: 'MULTI_FACTOR_STRATEGY',
    label: 'RESEARCH',
    dataQuality,
    data: { factors, compositeScore, computableFactorCount: computable.length },
  });
  emitResearchEvent('MULTI_FACTOR_EVALUATED', {
    researchRunId: result.researchRunId,
    traceId: opts.traceId,
    symbol: opts.symbol,
    compositeScore,
    computableFactorCount: computable.length,
  });
  return result;
}
