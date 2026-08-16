/**
 * ==========================================================
 * Module: scoring/GroupedScores
 *
 * Purpose:
 * Phase 6 of the additive quant layer - the "Probabilistic Decision Layer." Turns the already-
 * computed Phase 1-3 features (trend/momentum/volatility/volume/priceAction/supportResistance/
 * regime/marketContext) into a small set of GROUPED 0-100 scores for a specific candidate `side`
 * ('BUY' | 'SELL'), rather than counting how many individual indicators happen to agree.
 *
 * The plan's own explicit instruction: "RSI, MACD, Stochastic, CCI, etc. are correlated and must
 * not be treated as independent votes." Concretely, this means:
 *   - RSI, Stochastic RSI, CCI, and Williams %R are all bounded oscillators measuring the same
 *     underlying "is price stretched" latent factor - they are AVERAGED into one blended oscillator
 *     reading, not counted as 4 separate votes (4 correlated measurements of the same thing voting
 *     4 times would silently inflate confidence through redundancy, not real independent evidence).
 *   - MACD and ROC are a second, genuinely different-methodology momentum read (trend-following
 *     rate-of-change, not a bounded oscillator) - blended into a second reading.
 *   - momentumScore is the average of those TWO readings, not an average (or a vote count) of 6
 *     individual indicators.
 * The same discipline applies to every other score below - each documents exactly which inputs it
 * blends and why they're treated as one signal or several.
 *
 * Every score is 0-100. For every DIRECTIONAL score (does this dimension favor the candidate
 * `side`?), 50 = neutral/no real read either way, 100 = strongly favors `side`, 0 = strongly
 * opposes it. `volatilityScore` is the one deliberate exception - volatility has no inherent
 * bullish/bearish direction, so it reports 0-100 "conduciveness" (is there enough real movement
 * for this kind of setup to matter at all) and is reported separately rather than folded into
 * `overallSetupScore`, per the plan's own "only expose features with a clear purpose" instruction.
 *
 * `newsScore`/`forecastScore` are DELIBERATELY NOT computed here, even though the plan's own group
 * list names "News" and "Forecast Models": there is no deterministic calculation for either - News
 * sentiment already comes from a real AI call (NewsScoringEngine), and forecasts come from a
 * separate real subsystem (KronosForecastAgent/KronosEngine) - producing a "newsScore" here would
 * mean either recomputing what those systems already do (duplicating them) or fabricating a number
 * with no real backing. Both remain out of this deterministic module's scope; Phase 7's AI
 * integration layer is the correct place for news/forecast interpretation, not this one.
 *
 * Never fetches data itself - pure functions over the exact same StrategyContext shape
 * strategies/types.ts already defines, so this can be called with the identical inputs
 * QuantSignalAgent already assembles for the Strategy Engine.
 * ==========================================================
 */
import { TrendFeatures } from '../indicators/trend';
import { MomentumFeatures } from '../indicators/momentum';
import { VolatilityFeatures } from '../indicators/volatility';
import { VolumeFeatures } from '../indicators/volume';
import { PriceActionFeatures } from '../indicators/priceAction';
import { RegimeResult } from '../RegimeEngine';
import { MarketContextResult, BenchmarkTrend } from '../MarketContext';
import { quantThresholds } from '../../config/quantThresholds';

export type Side = 'BUY' | 'SELL';

export interface GroupedScores {
  trendScore: number; // 0-100, favors `side`
  momentumScore: number; // 0-100, favors `side`
  volatilityScore: number; // 0-100, non-directional "conduciveness" - see header
  volumeScore: number; // 0-100, favors `side`
  vwapScore: number; // 0-100, favors `side`
  marketScore: number; // 0-100, favors `side` (SPY alignment)
  sectorScore: number; // 0-100, favors `side` (sector-ETF alignment)
  relativeStrengthScore: number; // 0-100, favors `side` (vs SPY)
  priceStructureScore: number; // 0-100, favors `side` (market structure + price action)
  overallSetupScore: number; // 0-100, weighted blend of every score above EXCEPT volatilityScore
  dataCompletePct: number; // 0-100 - % of the underlying sub-signals that were real (not a neutral 50 fallback due to missing data)
}

const NEUTRAL = quantThresholds.groupedScoreNeutral;

/** Clamps into [0,100] and rounds - every score-producing helper below funnels through this so the
 *  public interface is guaranteed well-formed regardless of how extreme an intermediate blend gets. */
function clampScore(n: number): number {
  return Math.round(Math.max(0, Math.min(100, n)));
}

/** Maps a signed "how much does this favor BUY" reading (any real range, e.g. a %) onto 0-100
 *  centered at 50, saturating at `saturateAt` (the magnitude that already counts as "fully"
 *  favoring one side - beyond it, more magnitude doesn't add more score, avoiding a single
 *  extreme outlier input from silently dominating the blend). Then flips for a SELL candidate,
 *  since "favors BUY" and "favors SELL" are mirror images of the same underlying signed reading. */
function directionalScoreFromSignedReading(signedForBuy: number | null, saturateAt: number, side: Side): { score: number; real: boolean } {
  if (signedForBuy === null || !Number.isFinite(signedForBuy)) return { score: NEUTRAL, real: false };
  const buyScore = clampScore(NEUTRAL + (signedForBuy / saturateAt) * NEUTRAL);
  return { score: side === 'BUY' ? buyScore : 100 - buyScore, real: true };
}

/** Same idea for an already-boolean/tri-state directional read (e.g. "regime is bullish/bearish/
 *  neither") rather than a continuous signed number. */
function directionalScoreFromVote(vote: boolean | null, side: Side, weight: number = NEUTRAL): { score: number; real: boolean } {
  if (vote === null) return { score: NEUTRAL, real: false };
  const bullish = vote;
  const favorsBuy = bullish;
  const score = clampScore(NEUTRAL + (favorsBuy ? weight : -weight));
  return { score: side === 'BUY' ? score : 100 - score, real: true };
}

// ---------------------------------------------------------------------------
// trendScore - reuses RegimeEngine's own multi-signal regime read (already a real, tested,
// multi-vote-with-dead-zones classification) rather than re-deriving trend direction a second
// time from raw moving averages/DMI. This is the module explicitly NOT duplicating an existing
// calculation, per the plan's own rule.
// ---------------------------------------------------------------------------
function scoreTrend(regime: RegimeResult, side: Side): { score: number; real: boolean } {
  if (regime.regime === 'SIDEWAYS_RANGE' || regime.insufficientData) {
    // A real read, just not a directional one - honestly neutral, not treated as missing data.
    return { score: NEUTRAL, real: true };
  }
  const bullish = regime.regime === 'BULLISH_TREND';
  const magnitude = regime.confidence * (regime.trendStrength / 100) * NEUTRAL;
  const score = clampScore(NEUTRAL + (bullish ? magnitude : -magnitude));
  return { score: side === 'BUY' ? score : 100 - score, real: true };
}

// ---------------------------------------------------------------------------
// momentumScore - the score the plan's "don't vote-count correlated indicators" rule most directly
// targets. RSI/StochasticRSI/CCI/WilliamsR are 4 bounded oscillators measuring the same overbought/
// oversold latent factor - averaged into ONE reading (oscillatorAvg), not 4 votes. MACD histogram
// and ROC are a second, genuinely different-methodology momentum read (trend-following rate of
// change rather than a bounded oscillator) - averaged into a second, separate reading
// (trendMomentumAvg). The final score blends those TWO readings 50/50 - two real signals, not six.
// ---------------------------------------------------------------------------
function scoreMomentum(momentum: MomentumFeatures, side: Side): { score: number; real: boolean } {
  // Each oscillator rescaled to a common "-1 (fully bearish) .. 0 (neutral) .. +1 (fully bullish)"
  // scale before averaging, so no single oscillator's native range dominates the average.
  const rsiNorm = (momentum.rsi - 50) / 50; // 0-100 centered 50
  const stochRsiNorm = momentum.stochasticRSI !== null ? (momentum.stochasticRSI - 50) / 50 : null;
  const cciNorm = momentum.cci !== null ? Math.max(-1, Math.min(1, momentum.cci / 150)) : null; // CCI typically ranges roughly -150..150 in practice
  const williamsNorm = momentum.williamsR !== null ? (momentum.williamsR + 50) / 50 : null; // -100..0 centered -50

  const oscillatorReadings = [rsiNorm, stochRsiNorm, cciNorm, williamsNorm].filter((v): v is number => v !== null);
  const oscillatorAvg = oscillatorReadings.length > 0 ? oscillatorReadings.reduce((a, b) => a + b, 0) / oscillatorReadings.length : null;

  const macdNorm = momentum.macd.histogram !== 0 || momentum.macd.macd !== 0
    ? Math.max(-1, Math.min(1, (momentum.macd.macd - momentum.macd.signal) / (Math.abs(momentum.macd.signal) + 1)))
    : 0;
  const rocNorm = momentum.roc !== null ? Math.max(-1, Math.min(1, momentum.roc / 10)) : null; // +/-10% treated as a fully decisive ROC read
  const trendMomentumReadings = [macdNorm, rocNorm].filter((v): v is number => v !== null);
  const trendMomentumAvg = trendMomentumReadings.length > 0 ? trendMomentumReadings.reduce((a, b) => a + b, 0) / trendMomentumReadings.length : null;

  const signals = [oscillatorAvg, trendMomentumAvg].filter((v): v is number => v !== null);
  if (signals.length === 0) return { score: NEUTRAL, real: false };
  const blended = signals.reduce((a, b) => a + b, 0) / signals.length; // -1..1, positive = bullish

  const buyScore = clampScore(NEUTRAL + blended * NEUTRAL);
  return { score: side === 'BUY' ? buyScore : 100 - buyScore, real: true };
}

// ---------------------------------------------------------------------------
// volatilityScore - deliberately non-directional. volatilityPercentile is already a real,
// symbol-relative 0-100 read (VolatilityFeatures, RegimeEngine's own convention) - used directly,
// not blended with anything else, since it's already the right shape and re-deriving it would be
// exactly the duplicate-calculation the plan warns against.
// ---------------------------------------------------------------------------
function scoreVolatility(volatility: VolatilityFeatures): { score: number; real: boolean } {
  if (volatility.volatilityPercentile === null) return { score: NEUTRAL, real: false };
  return { score: clampScore(volatility.volatilityPercentile), real: true };
}

// ---------------------------------------------------------------------------
// volumeScore - relativeVolume (conviction magnitude, symmetric - a real spike matters regardless
// of which side it's confirming) blended with CMF's directional sign (does real money-flow support
// this side). Two genuinely distinct real signals (participation level vs. flow direction), not a
// vote count over volumeSMA/RVOL/spike/ROC/OBV/CMF/AD treated as six independent indicators - most
// of those are different views of the same participation-level fact.
// ---------------------------------------------------------------------------
function scoreVolume(volume: VolumeFeatures, side: Side): { score: number; real: boolean } {
  const convictionBoost = volume.relativeVolume !== null ? Math.min(1, Math.max(0, (volume.relativeVolume - 1) / 2)) : null; // 0 at RVOL<=1, 1 at RVOL>=3
  const cmfDirectional = volume.cmf !== null ? Math.max(-1, Math.min(1, volume.cmf / 0.2)) : null; // CMF typically -0.2..0.2 in practice

  if (convictionBoost === null && cmfDirectional === null) return { score: NEUTRAL, real: false };

  // Conviction alone doesn't favor either side - it only matters combined with a real directional
  // flow read; without one, report the honest neutral rather than let volume alone imply direction.
  if (cmfDirectional === null) return { score: NEUTRAL, real: convictionBoost !== null };

  const buyLean = cmfDirectional * NEUTRAL * (convictionBoost !== null ? 0.5 + convictionBoost * 0.5 : 1);
  const buyScore = clampScore(NEUTRAL + buyLean);
  return { score: side === 'BUY' ? buyScore : 100 - buyScore, real: true };
}

// ---------------------------------------------------------------------------
// vwapScore - one real signal (distance from session VWAP, sign = direction, magnitude = strength,
// saturating at 1% since intraday VWAP distances rarely exceed that meaningfully) with the real
// RECLAIM/REJECTION crossing event as a confirming nudge - not a second independent vote, since the
// event is derived from (and correlated with) the same crossing distancePct is already measuring.
// ---------------------------------------------------------------------------
function scoreVWAP(volume: VolumeFeatures, side: Side): { score: number; real: boolean } {
  const { distancePct, event } = volume.vwap;
  if (distancePct === null) return { score: NEUTRAL, real: false };
  const base = directionalScoreFromSignedReading(distancePct, 1, side);
  if (event === 'NONE') return base;
  const eventFavorsBuy = event === 'RECLAIM';
  const nudge = side === 'BUY' ? (eventFavorsBuy ? 5 : -5) : (eventFavorsBuy ? -5 : 5);
  return { score: clampScore(base.score + nudge), real: true };
}

// ---------------------------------------------------------------------------
// marketScore / sectorScore - both reuse the exact same real BenchmarkTrend.regime (itself
// RegimeEngine's output, already real and multi-signal) rather than re-deriving a market/sector
// directional read from scratch - identical treatment to scoreTrend above, just applied to a
// different real regime (SPY / the sector ETF instead of the traded symbol itself).
// ---------------------------------------------------------------------------
function scoreBenchmarkAlignment(benchmark: BenchmarkTrend | null | undefined, side: Side): { score: number; real: boolean } {
  if (!benchmark?.regime) return { score: NEUTRAL, real: false };
  return scoreTrend(benchmark.regime, side);
}

// ---------------------------------------------------------------------------
// relativeStrengthScore - one real signal: how much the symbol's own period return outperformed/
// underperformed SPY's, saturating at +/-10 percentage points of relative outperformance.
// ---------------------------------------------------------------------------
function scoreRelativeStrength(marketContext: MarketContextResult, side: Side): { score: number; real: boolean } {
  const rs = marketContext.relativeStrengthVsSPY?.relativeStrengthPct;
  if (rs === null || rs === undefined) return { score: NEUTRAL, real: false };
  return directionalScoreFromSignedReading(rs, 10, side);
}

// ---------------------------------------------------------------------------
// priceStructureScore - real market-structure event (BOS/CHoCH, already a multi-condition
// detection in indicators/trend.ts) blended with real candlestick-pattern/gap confirmation. Two
// distinct real signal types (structural break vs. single-bar pattern), not a vote count over
// every price-action sub-field.
// ---------------------------------------------------------------------------
function scorePriceStructure(trend: TrendFeatures, priceAction: PriceActionFeatures, side: Side): { score: number; real: boolean } {
  const votes: (boolean | null)[] = [];

  const structureVote = trend.structure.event === 'BOS_BULLISH' ? true
    : trend.structure.event === 'BOS_BEARISH' ? false
    : trend.structure.event === 'CHOCH_BULLISH' ? true
    : trend.structure.event === 'CHOCH_BEARISH' ? false
    : null;
  votes.push(structureVote);

  const bullishCandles = new Set(['HAMMER', 'BULLISH_ENGULFING']);
  const bearishCandles = new Set(['SHOOTING_STAR', 'BEARISH_ENGULFING']);
  const candleVote = priceAction.candlestick && bullishCandles.has(priceAction.candlestick) ? true
    : priceAction.candlestick && bearishCandles.has(priceAction.candlestick) ? false
    : null;
  votes.push(candleVote);

  const gapVote = priceAction.gap.type === 'GAP_UP' ? true : priceAction.gap.type === 'GAP_DOWN' ? false : null;
  votes.push(gapVote);

  const real = votes.filter((v): v is boolean => v !== null);
  if (real.length === 0) return { score: NEUTRAL, real: false };
  const bullishRatio = real.filter(v => v).length / real.length;
  const buyScore = clampScore(NEUTRAL + (bullishRatio - 0.5) * 2 * NEUTRAL);
  return { score: side === 'BUY' ? buyScore : 100 - buyScore, real: true };
}

// Weights for overallSetupScore - documented explicitly per the plan's own instruction. Trend and
// Momentum carry the most weight (the two most direct measures of "is this move real and ongoing");
// Market/Sector/RelativeStrength together weight context as heavily as the symbol's own technicals,
// since a technically-perfect setup fighting its own market/sector is real, demonstrated evidence
// against it, not a footnote. Volume/VWAP/PriceStructure are confirmation-weight, not primary
// signals on their own. Sums to 1.0; volatilityScore is intentionally excluded (see header).
const OVERALL_WEIGHTS = quantThresholds.groupedScoreWeights;

export interface GroupedScoresInput {
  trend: TrendFeatures;
  momentum: MomentumFeatures;
  volatility: VolatilityFeatures;
  volume: VolumeFeatures;
  priceAction: PriceActionFeatures;
  regime: RegimeResult;
  marketContext: MarketContextResult;
}

export function computeGroupedScores(input: GroupedScoresInput, side: Side): GroupedScores {
  const trend = scoreTrend(input.regime, side);
  const momentum = scoreMomentum(input.momentum, side);
  const volatility = scoreVolatility(input.volatility);
  const volume = scoreVolume(input.volume, side);
  const vwap = scoreVWAP(input.volume, side);
  const market = scoreBenchmarkAlignment(input.marketContext.spy, side);
  const sector = scoreBenchmarkAlignment(input.marketContext.sector.trend, side);
  const relativeStrength = scoreRelativeStrength(input.marketContext, side);
  const priceStructure = scorePriceStructure(input.trend, input.priceAction, side);

  const overallSetupScore = clampScore(
    trend.score * OVERALL_WEIGHTS.trend +
    momentum.score * OVERALL_WEIGHTS.momentum +
    market.score * OVERALL_WEIGHTS.market +
    sector.score * OVERALL_WEIGHTS.sector +
    relativeStrength.score * OVERALL_WEIGHTS.relativeStrength +
    volume.score * OVERALL_WEIGHTS.volume +
    vwap.score * OVERALL_WEIGHTS.vwap +
    priceStructure.score * OVERALL_WEIGHTS.priceStructure
  );

  const allReal = [trend.real, momentum.real, volatility.real, volume.real, vwap.real, market.real, sector.real, relativeStrength.real, priceStructure.real];
  const dataCompletePct = Math.round((allReal.filter(Boolean).length / allReal.length) * 100);

  return {
    trendScore: trend.score,
    momentumScore: momentum.score,
    volatilityScore: volatility.score,
    volumeScore: volume.score,
    vwapScore: vwap.score,
    marketScore: market.score,
    sectorScore: sector.score,
    relativeStrengthScore: relativeStrength.score,
    priceStructureScore: priceStructure.score,
    overallSetupScore,
    dataCompletePct,
  };
}
