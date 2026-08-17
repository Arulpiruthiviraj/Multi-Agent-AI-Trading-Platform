/**
 * Research-only StrategyContext evaluate() parity harness.
 * Reuses the same feature engines as argusStrategyReplay — never OMS/RiskEngine.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import type { Bar } from '../engines/backtest/HistoricalDataGateway';
import { classifyRegime } from '../quant/RegimeEngine';
import { computeMomentumFeatures } from '../quant/indicators/momentum';
import { computeVolumeFeatures } from '../quant/indicators/volume';
import { computeSupportResistanceFeatures } from '../quant/indicators/supportResistance';
import { CORE_STRATEGIES } from '../quant/strategies/StrategyEngine';
import type { StrategyContext, StrategyEvaluation } from '../quant/strategies/types';
import { unavailableMarketContext } from './argusStrategyReplay';
import { buildParityBars, computeStrategyContextParity, type ParityBar } from './strategyContextParity';
import { quantThresholds } from '../config/quantThresholds';

export const STRATEGY_PARITY_TOLERANCE = 1e-4;
export const CORE_STRATEGY_IDS = [
  'MOMENTUM_BREAKOUT',
  'PULLBACK_CONTINUATION',
  'MEAN_REVERSION',
  'TREND_FOLLOWING',
  'RANGE_REVERSION',
] as const;

export type SlimEvaluation = {
  strategy: string;
  side: 'BUY' | 'SELL';
  setupScore: number;
  confidence: number;
  conditionsMetCount: number;
  conditionsFailedCount: number;
  contradictionsCount: number;
  stopPrice: number | null;
  targetPrice: number | null;
  signalActive: boolean;
};

/** JSON-safe context snapshot consumed by Python evaluate ports. */
export function slimContext(ctx: StrategyContext): Record<string, unknown> {
  const { regime } = ctx;
  return {
    symbol: ctx.symbol,
    currentPrice: ctx.currentPrice,
    trend: {
      movingAverages: ctx.trend.movingAverages,
      priceVsSMA20: ctx.trend.priceVsSMA20,
      priceVsSMA50: ctx.trend.priceVsSMA50,
      priceVsSMA200: ctx.trend.priceVsSMA200,
      sma50SlopePct: ctx.trend.sma50SlopePct,
      dmi: ctx.trend.dmi,
      structure: ctx.trend.structure,
    },
    momentum: ctx.momentum,
    volatility: {
      atr: ctx.volatility.atr,
      atrPercent: ctx.volatility.atrPercent,
      keltner: ctx.volatility.keltner,
      regime: ctx.volatility.regime,
      volatilityPercentile: ctx.volatility.volatilityPercentile,
    },
    volume: {
      relativeVolume: ctx.volume.relativeVolume,
      isSpike: ctx.volume.isSpike,
      vwap: ctx.volume.vwap,
      cmf: ctx.volume.cmf,
    },
    priceAction: {
      consolidating: ctx.priceAction.consolidating,
      candlestick: ctx.priceAction.candlestick,
    },
    supportResistance: {
      nearest: ctx.supportResistance.nearest,
    },
    regime: {
      regime: regime.regime,
      trendStrength: regime.trendStrength,
      volatility: regime.volatility,
      marketStructure: regime.marketStructure,
      confidence: regime.confidence,
      insufficientData: regime.insufficientData,
    },
    marketContext: {
      sector: ctx.marketContext.sector,
      relativeStrengthVsSPY: ctx.marketContext.relativeStrengthVsSPY,
    },
  };
}

export function slimEvaluation(ev: StrategyEvaluation, minConfidence = 0): SlimEvaluation {
  return {
    strategy: ev.strategy,
    side: ev.side,
    setupScore: ev.setupScore,
    confidence: ev.confidence,
    conditionsMetCount: ev.conditionsMet.length,
    conditionsFailedCount: ev.conditionsFailed.length,
    contradictionsCount: ev.contradictions.length,
    stopPrice: ev.stop.price,
    targetPrice: ev.target.price,
    signalActive: ev.confidence >= minConfidence,
  };
}

export function buildStrategyContextFromBars(bars: ParityBar[], symbol = 'PARITY'): StrategyContext {
  const mapped: Bar[] = bars.map((b) => ({ ...b }));
  const regime = classifyRegime(mapped);
  return {
    symbol,
    currentPrice: mapped[mapped.length - 1].close,
    trend: regime.features.trend,
    volatility: regime.features.volatility,
    priceAction: regime.features.priceAction,
    momentum: computeMomentumFeatures(mapped),
    volume: computeVolumeFeatures(mapped),
    supportResistance: computeSupportResistanceFeatures(mapped),
    regime,
    marketContext: unavailableMarketContext(),
  };
}

export function evaluateCoreStrategies(ctx: StrategyContext): SlimEvaluation[] {
  return CORE_STRATEGIES.filter((s) => (CORE_STRATEGY_IDS as readonly string[]).includes(s.id)).map((s) =>
    slimEvaluation(s.evaluate(ctx)),
  );
}

export interface StrategyParityGolden {
  provenance: 'UNIT_FIXTURE';
  fullStrategyParity: true;
  note: string;
  absTolerance: number;
  bars: ParityBar[];
  indicators: ReturnType<typeof computeStrategyContextParity>;
  context: Record<string, unknown>;
  evaluations: SlimEvaluation[];
  thresholds: Record<string, number>;
}

export function buildStrategyParityGolden(barCount = 220): StrategyParityGolden {
  const bars = buildParityBars(barCount);
  const ctx = buildStrategyContextFromBars(bars);
  return {
    provenance: 'UNIT_FIXTURE',
    fullStrategyParity: true,
    note: 'Full CORE evaluate() parity vs Python ports on identical slim context. Research-only. Not an edge. Not LIVE.',
    absTolerance: STRATEGY_PARITY_TOLERANCE,
    bars,
    indicators: computeStrategyContextParity(bars),
    context: slimContext(ctx),
    evaluations: evaluateCoreStrategies(ctx),
    thresholds: {
      rvolThreshold: Number(quantThresholds.rvolThreshold),
      rsiOversold: Number(quantThresholds.rsiOversold),
      rsiOverbought: Number(quantThresholds.rsiOverbought),
      stochRsiOversold: Number(quantThresholds.stochRsiOversold),
      stochRsiOverbought: Number(quantThresholds.stochRsiOverbought),
      healthyRsiMin: Number(quantThresholds.healthyRsiMin),
      healthyRsiMax: Number(quantThresholds.healthyRsiMax),
      minTrendStrength: Number(quantThresholds.minTrendStrength),
      minAdxTrending: Number(quantThresholds.minAdxTrending),
      pullbackTolerancePct: Number(quantThresholds.pullbackTolerancePct),
      nearBoundaryPct: Number(quantThresholds.nearBoundaryPct),
    },
  };
}

export function defaultStrategyParityFixturePath(cwd = process.cwd()): string {
  return join(cwd, 'tests', 'fixtures', 'strategy_parity_golden.json');
}

export function writeStrategyParityGolden(path = defaultStrategyParityFixturePath()): StrategyParityGolden {
  const golden = buildStrategyParityGolden();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(golden, null, 2)}\n`, 'utf8');
  return golden;
}

export function compareSlimEvaluations(
  expected: SlimEvaluation[],
  actual: SlimEvaluation[],
  tol = STRATEGY_PARITY_TOLERANCE,
): { ok: boolean; rows: Array<{ field: string; ok: boolean; ts: unknown; py: unknown }> } {
  const rows: Array<{ field: string; ok: boolean; ts: unknown; py: unknown }> = [];
  const numEq = (a: number | null | undefined, b: number | null | undefined) => {
    if (a == null && b == null) return true;
    if (typeof a !== 'number' || typeof b !== 'number') return a === b;
    return Math.abs(a - b) <= tol;
  };
  for (const id of CORE_STRATEGY_IDS) {
    const e = expected.find((x) => x.strategy === id);
    const a = actual.find((x) => x.strategy === id);
    if (!e || !a) {
      rows.push({ field: `${id}.present`, ok: false, ts: !!e, py: !!a });
      continue;
    }
    rows.push({ field: `${id}.side`, ok: e.side === a.side, ts: e.side, py: a.side });
    rows.push({ field: `${id}.setupScore`, ok: numEq(e.setupScore, a.setupScore), ts: e.setupScore, py: a.setupScore });
    rows.push({ field: `${id}.confidence`, ok: numEq(e.confidence, a.confidence), ts: e.confidence, py: a.confidence });
    rows.push({
      field: `${id}.conditionsMetCount`,
      ok: e.conditionsMetCount === a.conditionsMetCount,
      ts: e.conditionsMetCount,
      py: a.conditionsMetCount,
    });
    rows.push({
      field: `${id}.conditionsFailedCount`,
      ok: e.conditionsFailedCount === a.conditionsFailedCount,
      ts: e.conditionsFailedCount,
      py: a.conditionsFailedCount,
    });
    rows.push({ field: `${id}.stopPrice`, ok: numEq(e.stopPrice, a.stopPrice), ts: e.stopPrice, py: a.stopPrice });
    rows.push({ field: `${id}.targetPrice`, ok: numEq(e.targetPrice, a.targetPrice), ts: e.targetPrice, py: a.targetPrice });
    rows.push({ field: `${id}.signalActive`, ok: e.signalActive === a.signalActive, ts: e.signalActive, py: a.signalActive });
  }
  return { ok: rows.every((r) => r.ok), rows };
}
