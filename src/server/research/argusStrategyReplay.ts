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
  /**
   * Skip re-evaluating every historical bar and only evaluate the final one. Default (false/
   * omitted) preserves the original full-history behavior every other caller (researchRoutes.ts,
   * canonicalNextBarEngine.ts, batch research/backtest call sites) relies on.
   *
   * FullArgusReplayEngine.ts calls this function fresh on every simulated tick with `bars` being
   * that tick's entire accumulated visible-bar history, then only ever reads
   * `signals[signals.length - 1]` (see FullArgusReplayEngine.ts's `replayArgusStrategy({...})` call
   * site). Without this flag, the internal loop below re-evaluates every historical bar-endpoint
   * from MIN_BARS onward on every tick, each endpoint itself costing O(that endpoint's bar count)
   * for its indicator computation - one call at tick T therefore costs O(T^2), and summed over all
   * N ticks in a replay that is O(N^3) total. This flag reduces one call to a single evaluation of
   * the latest bar only - O(current bar count) for that one indicator computation, not O(1), since
   * momentum/volume/support-resistance/SMC features still genuinely need the historical window -
   * but summed over N ticks that is O(N^2) total instead of O(N^3), which is what actually mattered
   * in practice (measured ~0.67s/bar early in a replay run degrading to ~10s/bar by bar 250 -
   * consistent with O(N^3), and this flag was the fix). Independently verified not to change which
   * signal is returned for the latest bar - it only skips redundant re-computation of earlier
   * bar-endpoints the caller was already discarding.
   */
  onlyLatestBar?: boolean;
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

  // bars.length >= MIN_BARS is already guaranteed by the early return above, so
  // bars.length - 1 >= MIN_BARS - 1 always holds here.
  const startIdx = opts.onlyLatestBar ? bars.length - 1 : MIN_BARS - 1;
  for (let i = startIdx; i < bars.length; i++) {
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
