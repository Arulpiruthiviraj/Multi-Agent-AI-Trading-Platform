/**
 * ExitIntelligenceEngine — pure, read-only opinion on an open position, consumed by
 * PortfolioMonitor.ts alongside its existing quant-stop/thesis/generic-trailing checks.
 *
 * Never places orders. Never imports EventBus, RiskEngine, OrderManagement, or BrokerManager -
 * enforced by architecture.protection.test.ts. PortfolioMonitor decides whether/how to act on
 * this opinion through the existing, unchanged emitRiskExit() -> RiskEngine -> OMS path.
 *
 * Reuses the same indicator math the CORE quant strategies and RegimeEngine already use
 * (src/server/quant/indicators/*) rather than reimplementing RSI/MACD/ADX/ATR - "is momentum
 * deteriorating while price still rises" is answered via the existing bearish-divergence
 * detector (detectPriceOscillatorDivergence), not a new indicator.
 *
 * See ARGUS_EXIT_INTELLIGENCE_PLAN.md for the full design rationale.
 */
import { Bar } from '../engines/backtest/HistoricalDataGateway';
import { computeTrendFeatures } from '../quant/indicators/trend';
import { computeMomentumFeatures, alignedRsiSeries, detectPriceOscillatorDivergence } from '../quant/indicators/momentum';
import { computeVolatilityFeatures } from '../quant/indicators/volatility';
import { exitIntelligenceConfig as cfg } from '../config/exitIntelligence';

export type ExitDecision = 'HOLD' | 'PARTIAL_TAKE_PROFIT' | 'TAKE_PROFIT' | 'TRAIL' | 'EXIT' | 'EMERGENCY_EXIT';

export interface ExitEvaluationInput {
  symbol: string;
  entryPrice: number;
  currentPrice: number;
  peakPriceSinceEntry: number;
  quantity: number;
  bars: Bar[];
}

export interface ExitEvaluation {
  decision: ExitDecision;
  suggestedSellFraction: number | null;
  exitScore: number;
  components: Record<string, number>;
  evidence: string[];
  confidence: number;
  reasoning: string;
  pnlPct: number;
  drawdownFromPeakPct: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function insufficientData(reason: string): ExitEvaluation {
  return {
    decision: 'HOLD',
    suggestedSellFraction: null,
    exitScore: 0,
    components: {},
    evidence: [`INSUFFICIENT_DATA: ${reason}`],
    confidence: 0,
    reasoning: `Not enough data to form an opinion (${reason}) - deferring to PortfolioMonitor's existing checks.`,
    pnlPct: 0,
    drawdownFromPeakPct: 0,
  };
}

export function evaluateExit(input: ExitEvaluationInput): ExitEvaluation {
  try {
    if (!Number.isFinite(input.entryPrice) || input.entryPrice <= 0 || !Number.isFinite(input.currentPrice) || input.currentPrice <= 0) {
      return insufficientData('invalid entry/current price');
    }
    if (!Array.isArray(input.bars) || input.bars.length < cfg.minBarsRequired) {
      return insufficientData(`only ${input.bars?.length ?? 0} bars, need ${cfg.minBarsRequired}`);
    }

    const pnlPct = ((input.currentPrice - input.entryPrice) / input.entryPrice) * 100;
    const peak = Number.isFinite(input.peakPriceSinceEntry) && input.peakPriceSinceEntry > 0
      ? Math.max(input.peakPriceSinceEntry, input.currentPrice, input.entryPrice)
      : Math.max(input.currentPrice, input.entryPrice);
    const drawdownFromPeakPct = peak > 0 ? ((peak - input.currentPrice) / peak) * 100 : 0;

    const closes = input.bars.map((b) => b.close);
    const trend = computeTrendFeatures(input.bars);
    const momentum = computeMomentumFeatures(input.bars);
    const volatility = computeVolatilityFeatures(input.bars);
    const rsiSeries = alignedRsiSeries(closes);
    const divergence = detectPriceOscillatorDivergence(closes, rsiSeries);

    const evidence: string[] = [];
    const components: Record<string, number> = {};

    // Momentum deterioration: RSI already overbought AND (bearish price/RSI divergence, or a
    // negative-and-shrinking MACD histogram) - "price still rising, momentum already fading".
    let momentumScore = 0;
    if (momentum.rsi >= cfg.rsiOverboughtForDeterioration) {
      momentumScore += 40;
      evidence.push(`RSI overbought (${momentum.rsi.toFixed(1)} >= ${cfg.rsiOverboughtForDeterioration})`);
    }
    if (divergence.kind === 'BEARISH') {
      momentumScore += 40;
      evidence.push('Bearish price/RSI divergence detected (higher price high, lower RSI high)');
    }
    if (momentum.macd.histogram < 0) {
      momentumScore += 20;
      evidence.push(`MACD histogram negative (${momentum.macd.histogram.toFixed(4)})`);
    }
    momentumScore = clamp(momentumScore, 0, 100);
    components.momentumDeterioration = momentumScore;

    // Trend weakening: real ADX below the trend-confirmation threshold (trend.dmi can be null on
    // thin data even after the minBarsRequired gate above - guard it, same fix applied across the
    // 8 CORE/EXPERIMENTAL strategies this session).
    let trendScore = 0;
    if (trend.dmi !== null && trend.dmi.adx !== null) {
      if (trend.dmi.adx < cfg.adxWeakeningThreshold) {
        trendScore = 100;
        evidence.push(`ADX below trend-confirmation threshold (${trend.dmi.adx.toFixed(1)} < ${cfg.adxWeakeningThreshold})`);
      } else {
        trendScore = clamp(100 - ((trend.dmi.adx - cfg.adxWeakeningThreshold) * 4), 0, 100);
      }
    } else {
      evidence.push('DMI/ADX unavailable this evaluation - trend-weakening component skipped, not fabricated');
    }
    components.trendWeakening = trendScore;

    // Profit protection pressure: only meaningful when actually in profit and pulling back from
    // the peak - a losing position doesn't get "profit protection" pressure, it gets risk pressure
    // via the other components instead.
    let pressureScore = 0;
    if (pnlPct > 0 && drawdownFromPeakPct > 0) {
      pressureScore = clamp((drawdownFromPeakPct / cfg.peakDrawbackForPressurePct) * 100, 0, 100);
      if (drawdownFromPeakPct >= cfg.peakDrawbackForPressurePct) {
        evidence.push(`Given back ${drawdownFromPeakPct.toFixed(1)}% from peak while still profitable (+${pnlPct.toFixed(1)}%)`);
      }
    }
    components.profitProtectionPressure = pressureScore;

    // Volatility risk: elevated ATR regime - real risk of a wide, fast move against the position.
    let volScore = 0;
    if (volatility.volatilityPercentile !== null) {
      if (volatility.volatilityPercentile >= cfg.elevatedAtrPercentileForRisk) {
        volScore = 100;
        evidence.push(`Volatility percentile elevated (${volatility.volatilityPercentile.toFixed(0)} >= ${cfg.elevatedAtrPercentileForRisk})`);
      } else {
        volScore = clamp((volatility.volatilityPercentile / cfg.elevatedAtrPercentileForRisk) * 60, 0, 60);
      }
    }
    components.volatilityRisk = volScore;

    const w = cfg.componentWeights;
    const totalWeight = w.momentumDeterioration + w.trendWeakening + w.profitProtectionPressure + w.volatilityRisk;
    const exitScore = totalWeight > 0
      ? (momentumScore * w.momentumDeterioration
        + trendScore * w.trendWeakening
        + pressureScore * w.profitProtectionPressure
        + volScore * w.volatilityRisk) / totalWeight
      : 0;

    let decision: ExitDecision = 'HOLD';
    let suggestedSellFraction: number | null = null;
    if (pnlPct < 0) {
      // Losing position: the question is capital protection, not profit-taking. Uses the same
      // score but a separate, lower band - a deteriorating losing position should not need to
      // wait for the same score threshold a profitable one does.
      if (exitScore >= cfg.exitScoreLossExit) {
        decision = 'EXIT';
        evidence.push(`Losing position (${pnlPct.toFixed(1)}%) with deteriorating evidence (score ${exitScore.toFixed(0)}) - capital protection.`);
      }
    } else if (exitScore >= cfg.exitScoreFullTakeProfit) {
      decision = 'TAKE_PROFIT';
    } else if (exitScore >= cfg.exitScorePartialTakeProfit) {
      decision = 'PARTIAL_TAKE_PROFIT';
      suggestedSellFraction = cfg.partialTakeProfitSellFraction;
    } else if (exitScore >= cfg.exitScoreHold && pressureScore > 0) {
      decision = 'TRAIL';
    }

    const confidence = clamp(exitScore / 100, 0, 1);
    const reasoning = decision === 'HOLD'
      ? `No dimension crossed its threshold (score ${exitScore.toFixed(0)}/100). Continuing to hold is the higher-evidence decision this cycle.`
      : `${decision} recommended: exitScore ${exitScore.toFixed(0)}/100 (pnl ${pnlPct.toFixed(1)}%, drawdown-from-peak ${drawdownFromPeakPct.toFixed(1)}%). ${evidence.join('; ')}`;

    return { decision, suggestedSellFraction, exitScore, components, evidence, confidence, reasoning, pnlPct, drawdownFromPeakPct };
  } catch (e) {
    // Never let a bug in this advisory scoring model abort a PortfolioMonitor review cycle -
    // degrade to "no opinion, defer to the existing checks" instead.
    return insufficientData(`internal evaluation error: ${(e as Error).message}`);
  }
}
