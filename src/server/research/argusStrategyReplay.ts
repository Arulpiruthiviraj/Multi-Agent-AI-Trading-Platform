/**
 * Research-only replay of CORE strategies using the same evaluate() + feature engines as live Quant.
 * Does not call OMS, BrokerManager, or HistoricalDataGateway.ensureBars.
 * Market context is UNAVAILABLE unless the caller supplies it — never invented.
 */
import type { Bar } from '../engines/backtest/HistoricalDataGateway';
import { classifyRegime, MIN_BARS } from '../quant/RegimeEngine';
import { computeMomentumFeatures } from '../quant/indicators/momentum';
import { computeVolumeFeatures } from '../quant/indicators/volume';
import { computeSupportResistanceFeatures } from '../quant/indicators/supportResistance';
import { computeSmcFeatures } from '../quant/indicators/smc';
import { findStrategy } from '../quant/strategies/StrategyEngine';
import type { MarketContextResult, BenchmarkTrend } from '../quant/MarketContext';
import type { StrategyEvaluation } from '../quant/strategies/types';
import type { DataProvenance, ResearchBar } from './ohlcvTypes';
import { isPromotableProvenance } from './importDataset';
import { executionModelVersion, getExecutionModel } from './executionModel';
import { loadStrategySpec } from './strategySpecs';

function emptyBenchmark(symbol: string): BenchmarkTrend {
  return { symbol, regime: null, source: 'UNAVAILABLE' };
}

export function unavailableMarketContext(): MarketContextResult {
  return {
    spy: emptyBenchmark('SPY'),
    qqq: emptyBenchmark('QQQ'),
    iwm: emptyBenchmark('IWM'),
    sector: { name: null, etf: null, trend: null },
    relativeStrengthVsSPY: null,
    relativeStrengthVsSector: null,
    breadth: { available: false, reason: 'Research replay does not fetch or invent breadth/benchmarks.' },
  };
}

function toBar(b: ResearchBar): Bar {
  return { timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
}

export interface ArgusReplaySignal {
  barIndex: number;
  timestamp: number;
  side: StrategyEvaluation['side'];
  setupScore: number;
  confidence: number;
  stop: number | null;
  target: number | null;
  /** Same fields RiskAgent.ts uses to build a real StoredThesis for live trades (not invented for replay). */
  invalidationConditions: string[];
  applicableRegimes: string[];
  entryRegime: string | null;
}

export interface ArgusReplayResult {
  strategyId: string;
  engine: 'argus_ts_evaluate';
  canPlaceOrders: false;
  executionModel: string;
  executionModelVersion: string;
  provenance: DataProvenance;
  promotable: boolean;
  rejection: string | null;
  minBarsRequired: number;
  barCount: number;
  signalCount: number;
  signals: ArgusReplaySignal[];
  marketContext: 'UNAVAILABLE' | 'SUPPLIED';
  vectorbtParity: 'FEATURE_TRANSLATION' | 'PROXY_NOT_FEATURE_PARITY' | 'FEATURE_PARITY_ESTABLISHED' | 'FEATURE_SUBSET_PARITY';
}

export function replayArgusStrategy(opts: {
  strategyId: string;
  bars: ResearchBar[];
  provenance: DataProvenance;
  minConfidence?: number;
}): ArgusReplayResult {
  const execution = getExecutionModel('NEXT_BAR_OPEN');
  const strategy = findStrategy(opts.strategyId);
  const base: Omit<ArgusReplayResult, 'signalCount' | 'signals' | 'rejection'> = {
    strategyId: opts.strategyId,
    engine: 'argus_ts_evaluate',
    canPlaceOrders: false,
    executionModel: execution.executionModel,
    executionModelVersion: executionModelVersion(),
    provenance: opts.provenance,
    promotable: false,
    minBarsRequired: MIN_BARS,
    barCount: opts.bars.length,
    marketContext: 'UNAVAILABLE',
    vectorbtParity: (loadStrategySpec(opts.strategyId)?.vectorbtParity as ArgusReplayResult['vectorbtParity'])
      ?? 'PROXY_NOT_FEATURE_PARITY',
  };

  if (!strategy) {
    return { ...base, signalCount: 0, signals: [], rejection: 'NO_DATA' };
  }
  if (opts.bars.length < MIN_BARS) {
    return { ...base, signalCount: 0, signals: [], rejection: 'INSUFFICIENT_SAMPLE' };
  }
  if (!isPromotableProvenance(opts.provenance)) {
    // Still compute signals for correctness, but never promotable.
  }

  const minConf = opts.minConfidence ?? 0;
  const bars = opts.bars.map(toBar);
  const marketContext = unavailableMarketContext();
  const signals: ArgusReplaySignal[] = [];

  for (let i = MIN_BARS - 1; i < bars.length; i++) {
    const visible = bars.slice(0, i + 1);
    const regime = classifyRegime(visible);
    const currentPrice = visible[visible.length - 1].close;
    const evaluation = strategy.evaluate({
      symbol: 'RESEARCH',
      currentPrice,
      trend: regime.features.trend,
      volatility: regime.features.volatility,
      priceAction: regime.features.priceAction,
      momentum: computeMomentumFeatures(visible),
      volume: computeVolumeFeatures(visible),
      supportResistance: computeSupportResistanceFeatures(visible),
      regime,
      marketContext,
      smc: computeSmcFeatures(visible),
    });
    if (evaluation.confidence >= minConf) {
      signals.push({
        barIndex: i,
        timestamp: visible[visible.length - 1].timestamp,
        side: evaluation.side,
        setupScore: evaluation.setupScore,
        confidence: evaluation.confidence,
        stop: evaluation.stop.price,
        target: evaluation.target.price,
        invalidationConditions: evaluation.invalidationConditions ?? [],
        applicableRegimes: evaluation.applicableRegimes ?? [],
        entryRegime: regime.insufficientData ? null : regime.regime,
      });
    }
  }

  const rejection = !isPromotableProvenance(opts.provenance)
    ? 'SYNTHETIC_NOT_PROMOTABLE'
    : signals.length === 0
      ? 'INSUFFICIENT_TRADES'
      : null;

  return {
    ...base,
    signalCount: signals.length,
    signals,
    rejection,
    promotable: false,
  };
}
