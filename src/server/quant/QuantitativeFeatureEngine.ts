/**
 * Facade over already-computed StrategyContext / strategy evaluations / grouped scores.
 * Does not reimplement indicators. Divergence series are derived from the same RSIEngine/MACDEngine
 * the rest of the stack uses. Unavailable capabilities are explicit NOT_SUPPORTED records — never fabricated.
 */
import { Bar } from '../engines/backtest/HistoricalDataGateway';
import { priceVsMA, PriceVsMA } from './indicators/trend';
import {
  alignedMacdHistogramSeries,
  alignedRsiSeries,
  detectPriceOscillatorDivergence,
  DivergenceFeature,
} from './indicators/momentum';
import { StrategyContext, StrategyEvaluation } from './strategies/types';
import { regimeStrategyEligibility } from './strategies/StrategyEngine';
import { GroupedScores } from './scoring/GroupedScores';
import { TechnicalIndicators } from '../engines/TechnicalIndicators';

export type DataQualityStatus =
  | 'AVAILABLE'
  | 'STALE'
  | 'MISSING'
  | 'INVALID'
  | 'PROVIDER_ERROR'
  | 'RATE_LIMITED'
  | 'AUTH_ERROR'
  | 'MARKET_CLOSED'
  | 'NOT_SUPPORTED'
  | 'CALCULATION_ERROR'
  | 'INSUFFICIENT_DATA';

export interface UnavailableCapability {
  status: DataQualityStatus;
  whatHappened: string;
  why: string;
  impact: string;
  howToFix: string;
  tradingBlocked: boolean;
}

const FEATURE_ENGINE_VERSION = 1;

function notSupported(what: string, why: string, howToFix: string): UnavailableCapability {
  return {
    status: 'NOT_SUPPORTED',
    whatHappened: `${what} is not available.`,
    why,
    impact: 'This dimension is omitted from scoring. It does not invent a value and does not by itself block trading.',
    howToFix,
    tradingBlocked: false,
  };
}

function atrExpansionRatio(bars: Bar[], period: number = 14, avgLookback: number = 20): number | null {
  if (bars.length < period + avgLookback) return null;
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const closes = bars.map(b => b.close);
  const atrs: number[] = [];
  for (let end = period; end <= bars.length; end++) {
    atrs.push(TechnicalIndicators.calculateATR(highs.slice(0, end), lows.slice(0, end), closes.slice(0, end), period));
  }
  const current = atrs[atrs.length - 1];
  const window = atrs.slice(-avgLookback);
  const avg = window.reduce((a, b) => a + b, 0) / window.length;
  if (avg === 0 || !Number.isFinite(avg) || !Number.isFinite(current)) return null;
  return current / avg;
}

function keltnerBandwidthPct(ctx: StrategyContext): number | null {
  const k = ctx.volatility.keltner;
  if (!k || k.middle === 0) return null;
  return ((k.upper - k.lower) / k.middle) * 100;
}

export interface QuantitativeFeatureSnapshot {
  version: number;
  timestamp: string;
  source: string;
  calculationStatus: DataQualityStatus;
  symbol: string;
  currentPrice: number;
  trend: StrategyContext['trend'] & {
    distanceFromMA: {
      sma20: PriceVsMA | null;
      sma50: PriceVsMA | null;
      sma100: PriceVsMA | null;
      sma200: PriceVsMA | null;
      ema9: PriceVsMA | null;
      ema20: PriceVsMA | null;
      ema50: PriceVsMA | null;
      ema200: PriceVsMA | null;
    };
  };
  momentum: StrategyContext['momentum'] & {
    rsiDivergence: DivergenceFeature;
    macdDivergence: DivergenceFeature;
  };
  volatility: StrategyContext['volatility'] & {
    atrExpansionRatio: number | null;
    keltnerBandwidthPct: number | null;
  };
  volume: StrategyContext['volume'];
  vwap: StrategyContext['volume']['vwap'];
  supportResistance: StrategyContext['supportResistance'];
  priceAction: StrategyContext['priceAction'];
  regime: StrategyContext['regime'];
  marketContext: StrategyContext['marketContext'];
  groupedScores: { BUY: GroupedScores; SELL: GroupedScores };
  strategyEvaluations: StrategyEvaluation[];
  regimeEligibility: ReturnType<typeof regimeStrategyEligibility>;
  unavailable: Record<string, UnavailableCapability>;
}

export function snapshotFromStrategyContext(input: {
  ctx: StrategyContext;
  evaluations: StrategyEvaluation[];
  groupedScores: { BUY: GroupedScores; SELL: GroupedScores };
  bars?: Bar[];
}): QuantitativeFeatureSnapshot {
  const { ctx, evaluations, groupedScores, bars } = input;
  const mas = ctx.trend.movingAverages;
  const px = ctx.currentPrice;

  let rsiDivergence: DivergenceFeature = { kind: null, isTradeSignal: false, detail: 'INSUFFICIENT_DATA' };
  let macdDivergence: DivergenceFeature = { kind: null, isTradeSignal: false, detail: 'INSUFFICIENT_DATA' };
  let expansion: number | null = null;

  if (bars && bars.length >= 8) {
    const closes = bars.map(b => b.close);
    rsiDivergence = detectPriceOscillatorDivergence(closes, alignedRsiSeries(closes));
    macdDivergence = detectPriceOscillatorDivergence(closes, alignedMacdHistogramSeries(closes));
    expansion = atrExpansionRatio(bars);
  }

  return {
    version: FEATURE_ENGINE_VERSION,
    timestamp: new Date().toISOString(),
    source: 'QuantitativeFeatureEngine.snapshotFromStrategyContext',
    calculationStatus: 'AVAILABLE',
    symbol: ctx.symbol,
    currentPrice: px,
    trend: {
      ...ctx.trend,
      distanceFromMA: {
        sma20: ctx.trend.priceVsSMA20,
        sma50: ctx.trend.priceVsSMA50,
        sma100: priceVsMA(px, mas.sma100),
        sma200: ctx.trend.priceVsSMA200,
        ema9: priceVsMA(px, mas.ema9),
        ema20: priceVsMA(px, mas.ema20),
        ema50: priceVsMA(px, mas.ema50),
        ema200: priceVsMA(px, mas.ema200),
      },
    },
    momentum: {
      ...ctx.momentum,
      rsiDivergence,
      macdDivergence,
    },
    volatility: {
      ...ctx.volatility,
      atrExpansionRatio: expansion,
      keltnerBandwidthPct: keltnerBandwidthPct(ctx),
    },
    volume: ctx.volume,
    vwap: ctx.volume.vwap,
    supportResistance: ctx.supportResistance,
    priceAction: ctx.priceAction,
    regime: ctx.regime,
    marketContext: ctx.marketContext,
    groupedScores,
    strategyEvaluations: evaluations,
    regimeEligibility: regimeStrategyEligibility(evaluations, ctx.regime.regime),
    unavailable: {
      marketBreadth: notSupported(
        'Market breadth (advance/decline, % above SMA, new highs/lows)',
        'No breadth data source exists in this repository. MarketContext already reports breadth.available:false.',
        'Integrate a real breadth provider. Do not synthesize breadth from the handful of symbols Argus already fetches.',
      ),
      optionsAnalytics: notSupported(
        'Options IV / greeks / expected move from IV',
        'No options feed is wired through BrokerManager or HistoricalDataGateway.',
        'Add a provider that supplies options chains, then persist IV and greeks. Do not fabricate IV.',
      ),
      orderFlow: notSupported(
        'L2 order-book imbalance / volume delta',
        'Alpaca IEX (and this codebase) is top-of-book only. No L2 source exists.',
        'Add a paid L2 feed. Until then the Trading Arena depth heatmap remains unavailable by design.',
      ),
      volumeProfile: notSupported(
        'Volume profile / HVN / LVN',
        'No volume-at-price histogram is computed or stored.',
        'Requires tick or volume-bucket data this stack does not persist.',
      ),
      tsi: notSupported(
        'True Strength Index',
        'Not implemented. Correlated oscillators are already blended in GroupedScores; adding TSI as a separate vote would double-count momentum.',
        'Implement only if a strategy needs TSI as a distinct feature with tests — never as an extra BUY vote.',
      ),
      anchoredVwap: notSupported(
        'Anchored VWAP (earnings/event anchors)',
        'Session VWAP, slope, distance, reclaim, and rejection already exist in computeVWAPContext. Event-anchored VWAP needs an explicit anchor timestamp per event.',
        'Pass a real event timestamp into calculateSessionVWAP-style math; do not guess anchors.',
      ),
      pairsCointegration: notSupported(
        'Statistical arbitrage / cointegration / hedge ratio',
        'Correlation/beta exist in quant/statistics.ts; cointegration and spread half-life do not.',
        'Build a pairs module with point-in-time tests before any live eligibility. Leave UNVALIDATED until OOS evidence exists.',
      ),
      canadianCommoditiesFx: notSupported(
        'CAD/USD, crude, gold, natural gas, TSX breadth as live context',
        'MarketRegistry can classify Canadian symbols; no FX/commodity feed is wired into MarketContext.',
        'See ARGUS_CANADIAN_MARKET_READINESS.md. Do not enable Canadian live routing (IIROC).',
      ),
    },
  };
}
