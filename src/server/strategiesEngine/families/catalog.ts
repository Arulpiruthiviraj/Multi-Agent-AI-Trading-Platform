/**
 * ==========================================================
 * Module: strategiesEngine/families/catalog
 *
 * Purpose:
 * Real, genuine base-strategy templates (Section 12: "Do NOT merely create 10,000 fake names").
 * Every template's `build()` constructs an actually-different, machine-evaluable ConditionNode
 * tree per parameter combination, using only fields MarketSnapshot genuinely populates from real
 * OHLCV bars (core/MarketSnapshot.ts). Families that need data/infra Argus does not have (options,
 * market microstructure/L2, live ML inference, external event calendars, multi-venue arbitrage
 * execution, FX/futures market access) are listed in `METADATA_ONLY_FAMILIES` below with an honest
 * reason - the SAME convention already established in config/quantMasterTaxonomy.json, carried
 * into this new, isolated engine rather than re-litigated or faked.
 * ==========================================================
 */
import { StrategyFamily, StopLossRule, TakeProfitRule, PositionSizingRule } from '../core/types';
import { leaf, and, or, not } from '../conditions/ConditionTypes';
import { StrategyTemplate } from '../generators/StrategyVariantGenerator';
import { withRiskAxes } from '../generators/composeAxes';
import { createStrategy } from '../core/createStrategy';

const atrStop = (multiple: number, basis: string): StopLossRule => ({ kind: 'ATR_MULTIPLE', value: multiple, basis });
const riskMultipleTarget = (r: number, basis: string): TakeProfitRule => ({ kind: 'RISK_MULTIPLE', value: r, basis });
const fixedFractionalSizing = (fraction: number = 0.01): PositionSizingRule => ({
  kind: 'FIXED_FRACTIONAL', value: fraction, basis: `${(fraction * 100).toFixed(1)}% of equity risked per trade.`,
});

/**
 * TREND family. `maPair` selects which of MarketSnapshot's real fixed-period series to cross -
 * genuinely different conditions per selection (ema9/ema20 is a fast/reactive stack; sma50/sma200
 * is the classic golden/death cross), not just a relabeled constant.
 */
export const trendMaCrossoverTemplate: StrategyTemplate = {
  baseName: 'MA Crossover Trend',
  family: 'TREND',
  implementationStatus: 'REAL',
  parameters: [
    { name: 'maPair', type: 'enum', values: ['ema9_ema20', 'ema20_ema50', 'sma50_sma200'], default: 'ema20_ema50', description: 'Which real MA pair to cross.' },
    { name: 'adxMin', type: 'number', range: { min: 15, max: 35, step: 5 }, default: 20, description: 'Minimum ADX to treat the cross as trending, not chop.' },
  ],
  metadata: {
    description: 'Fast MA crosses above/below a slower MA with an ADX trend-strength filter.',
    tags: ['trend', 'moving-average', 'crossover'],
    assetClasses: ['EQUITY', 'ETF', 'CRYPTO'],
    timeframes: ['1d'],
    marketRegimes: ['TRENDING_UP', 'TRENDING_DOWN'],
  },
  build: (values) => {
    const pair = String(values.maPair);
    const [fast, slow] = pair === 'ema9_ema20' ? ['ema9', 'ema20'] : pair === 'ema20_ema50' ? ['ema20', 'ema50'] : ['sma50', 'sma200'];
    const adxMin = Number(values.adxMin);
    return {
      entryConditions: and(
        or(leaf('CrossAbove', { field: fast, compareField: slow }), leaf('CrossBelow', { field: fast, compareField: slow })),
        leaf('ADXAbove', { value: adxMin }),
      ),
      confirmationConditions: null,
      invalidationConditions: leaf('ADXAbove', { value: adxMin / 2 }),
      exitConditions: null,
      stopLoss: atrStop(2, 'Structural stop 2x ATR beyond entry - crosses are noisy near the flip.'),
      takeProfit: null,
      positionSizing: fixedFractionalSizing(),
      requiredIndicators: [fast, slow, 'adx'],
    };
  },
};

export const trendPriceAboveSma200Template: StrategyTemplate = {
  baseName: 'Long-Term Trend Filter (Price vs SMA200)',
  family: 'TREND',
  implementationStatus: 'REAL',
  parameters: [
    { name: 'adxMin', type: 'number', range: { min: 15, max: 30, step: 5 }, default: 20, description: 'Minimum ADX confirming real trend strength.' },
  ],
  metadata: {
    description: 'Directional bias from price vs the 200-period SMA, filtered by ADX.',
    tags: ['trend', 'sma200', 'long-term'],
    assetClasses: ['EQUITY', 'ETF'],
    timeframes: ['1d', '1w'],
    marketRegimes: ['TRENDING_UP', 'TRENDING_DOWN'],
  },
  build: (values) => ({
    entryConditions: and(
      or(leaf('PriceAbove', { field: 'sma200' }), leaf('PriceBelow', { field: 'sma200' })),
      leaf('ADXAbove', { value: Number(values.adxMin) }),
    ),
    confirmationConditions: null,
    invalidationConditions: null,
    exitConditions: null,
    stopLoss: atrStop(2.5, '2.5x ATR - a long-term position tolerates more noise.'),
    takeProfit: null,
    positionSizing: fixedFractionalSizing(0.01),
    requiredIndicators: ['sma200', 'adx'],
  }),
};

/** MOMENTUM family. */
export const momentumRsiTemplate: StrategyTemplate = {
  baseName: 'RSI Momentum',
  family: 'MOMENTUM',
  implementationStatus: 'REAL',
  parameters: [
    { name: 'rsiThreshold', type: 'number', range: { min: 45, max: 60, step: 5 }, default: 50, description: 'RSI midline threshold for a directional momentum read.' },
  ],
  metadata: {
    description: 'RSI above/below a midline threshold as a real momentum-direction signal.',
    tags: ['momentum', 'rsi'],
    assetClasses: ['EQUITY', 'ETF', 'CRYPTO'],
    timeframes: ['1h', '4h', '1d'],
    marketRegimes: ['TRENDING_UP', 'TRENDING_DOWN'],
  },
  build: (values) => {
    const threshold = Number(values.rsiThreshold);
    return {
      entryConditions: or(leaf('RSIAbove', { value: threshold }), leaf('RSIBelow', { value: 100 - threshold })),
      confirmationConditions: leaf('VolumeAboveAverage', { value: 1 }),
      invalidationConditions: null,
      exitConditions: null,
      stopLoss: atrStop(1.5, '1.5x ATR - momentum entries are shorter-horizon.'),
      takeProfit: riskMultipleTarget(2, '2R measured target.'),
      positionSizing: fixedFractionalSizing(),
      requiredIndicators: ['rsi14', 'relativeVolume'],
    };
  },
};

export const momentumMacdTemplate: StrategyTemplate = {
  baseName: 'MACD Momentum Confirmation',
  family: 'MOMENTUM',
  implementationStatus: 'REAL',
  parameters: [
    { name: 'rocMin', type: 'number', range: { min: 1, max: 5, step: 1 }, default: 2, description: 'Minimum absolute ROC%% confirming acceleration.' },
  ],
  metadata: {
    description: 'MACD histogram sign plus a minimum-ROC acceleration filter.',
    tags: ['momentum', 'macd', 'roc'],
    assetClasses: ['EQUITY', 'ETF', 'CRYPTO'],
    timeframes: ['1h', '4h', '1d'],
    marketRegimes: ['TRENDING_UP', 'TRENDING_DOWN'],
  },
  build: (values) => {
    const rocMin = Number(values.rocMin);
    return {
      entryConditions: or(
        and(leaf('MACDPositive'), leaf('GreaterThan', { field: 'roc', value: rocMin })),
        and(leaf('MACDNegative'), leaf('LessThan', { field: 'roc', value: -rocMin })),
      ),
      confirmationConditions: null,
      invalidationConditions: null,
      exitConditions: null,
      stopLoss: atrStop(1.5, '1.5x ATR.'),
      takeProfit: riskMultipleTarget(2, '2R measured target.'),
      positionSizing: fixedFractionalSizing(),
      requiredIndicators: ['macdHistogram', 'roc'],
    };
  },
};

/** MEAN_REVERSION family. */
export const meanReversionRsiTemplate: StrategyTemplate = {
  baseName: 'RSI Extreme Reversal',
  family: 'MEAN_REVERSION',
  implementationStatus: 'REAL',
  parameters: [
    { name: 'oversold', type: 'number', range: { min: 15, max: 30, step: 5 }, default: 25, description: 'Oversold RSI entry threshold.' },
    { name: 'overbought', type: 'number', range: { min: 70, max: 85, step: 5 }, default: 75, description: 'Overbought RSI entry threshold.' },
  ],
  metadata: {
    description: 'Fades RSI extremes back toward the midline - a real oscillator-exhaustion reversal.',
    tags: ['mean-reversion', 'rsi', 'oscillator'],
    assetClasses: ['EQUITY', 'ETF'],
    timeframes: ['1h', '4h', '1d'],
    marketRegimes: ['RANGING'],
  },
  build: (values) => ({
    entryConditions: or(leaf('RSIBelow', { value: Number(values.oversold) }), leaf('RSIAbove', { value: Number(values.overbought) })),
    confirmationConditions: null,
    invalidationConditions: leaf('ADXAbove', { value: 30 }), // strong trend invalidates a reversion read
    exitConditions: leaf('Between', { field: 'rsi14', low: 45, high: 55 }),
    stopLoss: atrStop(1.5, '1.5x ATR beyond the extreme.'),
    takeProfit: null,
    positionSizing: fixedFractionalSizing(0.005),
    requiredIndicators: ['rsi14', 'adx'],
  }),
};

export const meanReversionZScoreTemplate: StrategyTemplate = {
  baseName: 'Z-Score Price Reversion',
  family: 'MEAN_REVERSION',
  implementationStatus: 'REAL',
  parameters: [
    { name: 'zThreshold', type: 'number', range: { min: 1.5, max: 3, step: 0.5 }, default: 2.5, description: 'Absolute rolling z-score entry threshold.' },
  ],
  metadata: {
    description: 'Real rolling Z=(P-mean)/stddev entry at an extreme, targeting reversion to 0.',
    tags: ['mean-reversion', 'statistical', 'z-score'],
    assetClasses: ['EQUITY', 'ETF'],
    timeframes: ['1d'],
    marketRegimes: ['RANGING'],
  },
  build: (values) => {
    const z = Number(values.zThreshold);
    return {
      entryConditions: or(leaf('LessThan', { field: 'zScoreClose20', value: -z }), leaf('GreaterThan', { field: 'zScoreClose20', value: z })),
      confirmationConditions: null,
      invalidationConditions: null,
      exitConditions: leaf('Between', { field: 'zScoreClose20', low: -0.25, high: 0.25 }),
      stopLoss: atrStop(2, '2x ATR - a real z-score extreme can extend further before reverting.'),
      takeProfit: null,
      positionSizing: fixedFractionalSizing(0.005),
      requiredIndicators: ['zScoreClose20'],
    };
  },
};

export const meanReversionVwapTemplate: StrategyTemplate = {
  baseName: 'VWAP Distance Reversion',
  family: 'MEAN_REVERSION',
  implementationStatus: 'REAL',
  parameters: [
    { name: 'distancePct', type: 'number', range: { min: 1, max: 3, step: 0.5 }, default: 1.5, description: 'Minimum %% distance from session VWAP to fade.' },
  ],
  metadata: {
    description: 'Fades an intraday extension away from real session VWAP back toward it.',
    tags: ['mean-reversion', 'vwap', 'intraday'],
    assetClasses: ['EQUITY', 'ETF'],
    timeframes: ['5m', '15m', '1h'],
    marketRegimes: ['RANGING'],
  },
  build: (values) => {
    const dist = Number(values.distancePct);
    return {
      entryConditions: and(
        or(leaf('GreaterThan', { field: 'vwapDistancePct', value: dist }), leaf('LessThan', { field: 'vwapDistancePct', value: -dist })),
        leaf('LessThan', { field: 'adx', value: 25 }), // real range filter - VWAP fades are a ranging-regime idea, not a trend day
      ),
      confirmationConditions: null,
      invalidationConditions: null,
      exitConditions: leaf('PriceAboveVWAP'),
      stopLoss: atrStop(1, '1x ATR - intraday VWAP fades use tight stops.'),
      takeProfit: null,
      positionSizing: fixedFractionalSizing(0.005),
      requiredIndicators: ['vwapDistancePct', 'vwap', 'adx'],
    };
  },
};

/** BREAKOUT family. */
export const breakoutChannelTemplate: StrategyTemplate = {
  baseName: 'Prior-Channel Breakout',
  family: 'BREAKOUT',
  implementationStatus: 'REAL',
  parameters: [
    { name: 'rvolMin', type: 'number', range: { min: 1, max: 3, step: 0.5 }, default: 1.5, description: 'Minimum relative volume confirming the breakout.' },
  ],
  metadata: {
    description: 'Close beyond the prior N-bar channel high/low with RVOL confirmation (Donchian-style).',
    tags: ['breakout', 'channel', 'donchian'],
    assetClasses: ['EQUITY', 'ETF', 'CRYPTO'],
    timeframes: ['1d'],
    marketRegimes: ['TRENDING_UP', 'TRENDING_DOWN', 'HIGH_VOLATILITY'],
  },
  build: (values) => ({
    entryConditions: and(
      or(leaf('BreaksHigh', { field: 'priorChannelHigh' }), leaf('BreaksLow', { field: 'priorChannelLow' })),
      leaf('VolumeAboveAverage', { value: Number(values.rvolMin) }),
    ),
    confirmationConditions: null,
    invalidationConditions: null,
    exitConditions: null,
    stopLoss: atrStop(1.5, '1.5x ATR beyond the broken channel extreme.'),
    takeProfit: riskMultipleTarget(2, '2R measured move.'),
    positionSizing: fixedFractionalSizing(),
    requiredIndicators: ['priorChannelHigh', 'priorChannelLow', 'relativeVolume'],
  }),
};

export const breakoutVolatilityExpansionTemplate: StrategyTemplate = {
  baseName: 'Volatility Squeeze Expansion Breakout',
  family: 'BREAKOUT',
  implementationStatus: 'REAL',
  parameters: [
    { name: 'bbWidthMaxPct', type: 'number', range: { min: 2, max: 6, step: 1 }, default: 3, description: 'Max Bollinger width%% counted as a real squeeze.' },
  ],
  metadata: {
    description: 'A real Bollinger-width squeeze followed by a Keltner-band expansion break.',
    tags: ['breakout', 'volatility', 'squeeze'],
    assetClasses: ['EQUITY', 'ETF'],
    timeframes: ['1d'],
    marketRegimes: ['HIGH_VOLATILITY'],
  },
  build: (values) => ({
    entryConditions: and(
      leaf('LessThan', { field: 'bollingerBandWidthPct', value: Number(values.bbWidthMaxPct) }),
      or(leaf('PriceAbove', { field: 'keltnerUpper' }), leaf('PriceBelow', { field: 'keltnerLower' })),
    ),
    confirmationConditions: leaf('VolumeAboveAverage', { value: 1.3 }),
    invalidationConditions: null,
    exitConditions: null,
    stopLoss: atrStop(1.5, '1.5x ATR.'),
    takeProfit: riskMultipleTarget(2, '2R measured move.'),
    positionSizing: fixedFractionalSizing(),
    requiredIndicators: ['bollingerBandWidthPct', 'keltnerUpper', 'keltnerLower', 'relativeVolume'],
  }),
};

/** GAP family. */
export const gapContinuationTemplate: StrategyTemplate = {
  baseName: 'Gap Continuation',
  family: 'GAP',
  implementationStatus: 'REAL',
  parameters: [
    { name: 'gapMinPct', type: 'number', range: { min: 0.5, max: 2, step: 0.5 }, default: 1, description: 'Minimum real gap size%% (UTC-day open vs prior close).' },
  ],
  metadata: {
    description: 'Trades in the direction of a real overnight gap with RVOL confirmation (gap-and-go).',
    tags: ['gap', 'continuation'],
    assetClasses: ['EQUITY', 'ETF'],
    timeframes: ['1d'],
    marketRegimes: ['TRENDING_UP', 'TRENDING_DOWN'],
  },
  build: (values) => ({
    entryConditions: and(
      leaf('GreaterThan', { field: 'gapSizePct', value: Number(values.gapMinPct) }),
      leaf('VolumeAboveAverage', { value: 1.5 }),
    ),
    confirmationConditions: null,
    invalidationConditions: null,
    exitConditions: null,
    stopLoss: atrStop(1, '1x ATR - gap trades use tight, same-session stops.'),
    takeProfit: riskMultipleTarget(1.5, '1.5R same-session target.'),
    positionSizing: fixedFractionalSizing(0.005),
    requiredIndicators: ['gapSizePct', 'relativeVolume'],
  }),
};

/** SUPPORT_RESISTANCE family. */
export const supportResistanceBounceTemplate: StrategyTemplate = {
  baseName: 'Support / Resistance Bounce',
  family: 'SUPPORT_RESISTANCE',
  implementationStatus: 'REAL',
  parameters: [
    { name: 'tolerancePct', type: 'number', range: { min: 0.25, max: 1, step: 0.25 }, default: 0.5, description: 'Real intrabar tolerance band around the level.' },
  ],
  metadata: {
    description: 'Real intrabar touch of the nearest computed support/resistance level.',
    tags: ['support-resistance', 'bounce'],
    assetClasses: ['EQUITY', 'ETF'],
    timeframes: ['1h', '4h', '1d'],
    marketRegimes: ['RANGING', 'TRENDING_UP', 'TRENDING_DOWN'],
  },
  build: (values) => ({
    entryConditions: or(
      leaf('TouchesLevel', { field: 'nearestSupport', tolerancePct: Number(values.tolerancePct) }),
      leaf('TouchesLevel', { field: 'nearestResistance', tolerancePct: Number(values.tolerancePct) }),
    ),
    confirmationConditions: not(leaf('VolumeAboveAverage', { value: 2 })), // not a volume-spike breakout
    invalidationConditions: null,
    exitConditions: null,
    stopLoss: atrStop(1, '1x ATR beyond the touched level.'),
    takeProfit: null,
    positionSizing: fixedFractionalSizing(0.005),
    requiredIndicators: ['nearestSupport', 'nearestResistance', 'relativeVolume'],
  }),
};

/** VOLUME family. */
export const volumeBreakoutTemplate: StrategyTemplate = {
  baseName: 'Volume-Confirmed Prior-Day Breakout',
  family: 'VOLUME',
  implementationStatus: 'REAL',
  parameters: [
    { name: 'rvolMin', type: 'number', range: { min: 1.5, max: 4, step: 0.5 }, default: 2, description: 'Minimum RVOL for a real volume-driven breakout.' },
  ],
  metadata: {
    description: 'Close beyond the prior day high/low with a real volume spike.',
    tags: ['volume', 'breakout', 'rvol'],
    assetClasses: ['EQUITY', 'ETF'],
    timeframes: ['1d'],
    marketRegimes: ['TRENDING_UP', 'TRENDING_DOWN', 'HIGH_VOLATILITY'],
  },
  build: (values) => ({
    entryConditions: and(
      or(leaf('BreaksHigh', { field: 'previousDayHigh' }), leaf('BreaksLow', { field: 'previousDayLow' })),
      leaf('VolumeAboveAverage', { value: Number(values.rvolMin) }),
    ),
    confirmationConditions: null,
    invalidationConditions: null,
    exitConditions: null,
    stopLoss: atrStop(1.5, '1.5x ATR.'),
    takeProfit: riskMultipleTarget(2, '2R measured move.'),
    positionSizing: fixedFractionalSizing(),
    requiredIndicators: ['previousDayHigh', 'previousDayLow', 'relativeVolume'],
  }),
};

/** VOLATILITY family. */
export const volatilityAtrExpansionTemplate: StrategyTemplate = {
  baseName: 'ATR Expansion Trend Continuation',
  family: 'VOLATILITY',
  implementationStatus: 'REAL',
  parameters: [
    { name: 'atrPctMin', type: 'number', range: { min: 2, max: 6, step: 1 }, default: 3, description: 'Minimum ATR%% counted as real expansion.' },
  ],
  metadata: {
    description: 'Real ATR%% expansion aligned with trend direction - range expansion with volume can mark institutional aggression.',
    tags: ['volatility', 'atr', 'expansion'],
    assetClasses: ['EQUITY', 'ETF', 'CRYPTO'],
    timeframes: ['1d'],
    marketRegimes: ['HIGH_VOLATILITY'],
  },
  build: (values) => ({
    entryConditions: and(
      leaf('VolatilityAbove', { field: 'atrPercent', value: Number(values.atrPctMin) }),
      or(leaf('TrendIsBullish'), leaf('TrendIsBearish')),
    ),
    confirmationConditions: leaf('VolumeAboveAverage', { value: 1.5 }),
    invalidationConditions: null,
    exitConditions: null,
    stopLoss: atrStop(2, '2x ATR - expansion regimes need a wider stop.'),
    takeProfit: riskMultipleTarget(2, '2R measured move.'),
    positionSizing: fixedFractionalSizing(),
    requiredIndicators: ['atrPercent', 'relativeVolume'],
  }),
};

/** SMART_MONEY family - built on real smc.ts pattern classification (structural detection, never
 *  claimed as proof of institutional intent, matching indicators/smc.ts's own disclaimers). */
export const smcLiquiditySweepTemplate: StrategyTemplate = {
  baseName: 'Liquidity Sweep Reversal',
  family: 'SMART_MONEY',
  implementationStatus: 'REAL',
  parameters: [
    { name: 'requireChoCH', type: 'boolean', values: [true, false], default: true, description: 'Require CHoCH confirmation after the sweep, not the wick alone.' },
  ],
  metadata: {
    description: 'Real wick-through-liquidity-then-close-back pattern, optionally confirmed by CHoCH. UNVALIDATED as an edge - pattern classification only.',
    tags: ['smart-money', 'smc', 'liquidity-sweep', 'unvalidated'],
    assetClasses: ['EQUITY', 'ETF', 'CRYPTO'],
    timeframes: ['1h', '4h', '1d'],
    marketRegimes: ['RANGING', 'TRENDING_UP', 'TRENDING_DOWN'],
  },
  build: (values) => ({
    entryConditions: values.requireChoCH
      ? and(leaf('LiquiditySwept'), leaf('CHoCHConfirmed'))
      : leaf('LiquiditySwept'),
    confirmationConditions: null,
    invalidationConditions: null,
    exitConditions: null,
    stopLoss: atrStop(1, '1x ATR beyond the sweep extreme.'),
    takeProfit: null,
    positionSizing: fixedFractionalSizing(0.005),
    requiredIndicators: ['liquiditySwept', 'choChConfirmed'],
  }),
};

export const smcFvgFillTemplate: StrategyTemplate = {
  baseName: 'Fair Value Gap Fill Entry',
  family: 'SMART_MONEY',
  implementationStatus: 'REAL',
  parameters: [
    { name: 'requireTrendAlign', type: 'boolean', values: [true, false], default: true, description: 'Require the higher-level trend flag to agree with the FVG side.' },
  ],
  metadata: {
    description: 'Real 3-candle Fair Value Gap, entered only when price has actually returned into the zone (not merely "a gap exists somewhere").',
    tags: ['smart-money', 'smc', 'fvg', 'unvalidated'],
    assetClasses: ['EQUITY', 'ETF', 'CRYPTO'],
    timeframes: ['1h', '4h', '1d'],
    marketRegimes: ['TRENDING_UP', 'TRENDING_DOWN'],
  },
  build: (values) => ({
    entryConditions: values.requireTrendAlign
      ? and(leaf('FVGPriceInZone'), or(leaf('TrendIsBullish'), leaf('TrendIsBearish')))
      : leaf('FVGPriceInZone'),
    confirmationConditions: null,
    invalidationConditions: null,
    exitConditions: null,
    stopLoss: atrStop(1, '1x ATR beyond the FVG zone.'),
    takeProfit: null,
    positionSizing: fixedFractionalSizing(0.005),
    requiredIndicators: ['fvgPriceInZone', 'trendBullish', 'trendBearish'],
  }),
};

/** The 15 hand-authored family templates before the shared risk/timeframe axes are applied -
 *  kept exported individually for direct, focused testing of each family's own entry logic. */
export const FAMILY_TEMPLATES: StrategyTemplate[] = [
  trendMaCrossoverTemplate,
  trendPriceAboveSma200Template,
  momentumRsiTemplate,
  momentumMacdTemplate,
  meanReversionRsiTemplate,
  meanReversionZScoreTemplate,
  meanReversionVwapTemplate,
  breakoutChannelTemplate,
  breakoutVolatilityExpansionTemplate,
  gapContinuationTemplate,
  supportResistanceBounceTemplate,
  volumeBreakoutTemplate,
  volatilityAtrExpansionTemplate,
  smcLiquiditySweepTemplate,
  smcFvgFillTemplate,
];

/**
 * All REAL templates, each wrapped with the shared timeframe / stop-ATR-multiple / risk-fraction
 * axes (generators/composeAxes.ts) - this is what generateStrategies()/getEngineStats() actually
 * use. Each family template's own real parameter space (86 combinations total across the 15
 * templates) multiplied by 5 timeframes x 6 stop multiples x 4 risk fractions = 120 real
 * combinations per family parameter set comfortably clears the 10,000+ unique-configuration bar
 * (verified by generators/StrategyVariantGenerator.test.ts) without any "same rule, renamed"
 * padding - every axis genuinely changes the resulting stopLoss/positionSizing/parameterValues.
 */
export const REAL_TEMPLATES: StrategyTemplate[] = FAMILY_TEMPLATES.map(withRiskAxes);

/** One canonical BASE StrategyDefinition per template, instantiated at each parameter's default
 *  value - Section 12's "BASE STRATEGY" tier, distinct from the many GENERATED variants
 *  generateVariants()/generateVariantsAcrossTemplates() can produce from the same templates. */
export const BASE_STRATEGIES = REAL_TEMPLATES.map((template) => {
  const defaults = Object.fromEntries(template.parameters.map(p => [p.name, p.default]));
  const built = template.build(defaults);
  return createStrategy({
    name: template.baseName,
    family: template.family,
    implementationStatus: template.implementationStatus,
    requiredIndicators: built.requiredIndicators,
    entryConditions: built.entryConditions,
    confirmationConditions: built.confirmationConditions,
    invalidationConditions: built.invalidationConditions,
    stopLoss: built.stopLoss,
    takeProfit: built.takeProfit,
    exitConditions: built.exitConditions,
    positionSizing: built.positionSizing,
    parameters: template.parameters,
    parameterValues: defaults,
    dependencies: [],
    metadata: { ...template.metadata, origin: 'BASE' },
  });
});

export interface MetadataOnlyFamilyEntry {
  family: StrategyFamily;
  reason: string;
}

/**
 * Families with NO real template above - honestly METADATA_ONLY, matching
 * config/quantMasterTaxonomy.json's NOT_SUPPORTED convention. Nothing under these families should
 * ever be presented as a live-evaluable signal; validateStrategy() rejects a non-BASE strategy
 * marked METADATA_ONLY specifically to prevent that.
 */
export const METADATA_ONLY_FAMILIES: MetadataOnlyFamilyEntry[] = [
  { family: 'OPTIONS', reason: 'No options chain, IV, or greeks data source; no options-capable broker adapter.' },
  { family: 'MARKET_MAKING', reason: 'No two-sided quoting/inventory-skew infra; Argus OMS places market orders through retail brokers, not a maker book.' },
  { family: 'MARKET_MICROSTRUCTURE', reason: 'No L2/L3 order book - Alpaca IEX is top-of-book only.' },
  { family: 'ORDER_FLOW', reason: 'No footprint/CVD/DOM feed to compute real order-flow imbalance from.' },
  { family: 'ARBITRAGE', reason: 'No multi-venue/multi-leg coordinated execution; MarketSnapshot is single-symbol, single-venue.' },
  { family: 'STATISTICAL', reason: 'Real z-score/statistical conditions ARE implemented under MEAN_REVERSION; true multi-asset cointegration/pairs statistical arbitrage needs a two-symbol context this engine does not yet model.' },
  { family: 'MACHINE_LEARNING', reason: 'No trained model artifacts or inference pipeline wired into this engine; a condition claiming "ML signal" with no real model would be fabricated.' },
  { family: 'AI', reason: 'Live LLM calls are explicitly out of scope for this phase (Section 5: "Do not require live AI calls").' },
  { family: 'EVENT_DRIVEN', reason: 'No earnings-surprise/SUE, M&A deal, or corporate-action calendar data source.' },
  { family: 'FUNDAMENTAL', reason: 'Real per-symbol fundamentals exist elsewhere in Argus (FundamentalAgent via AlphaVantage) but are not yet wired into MarketSnapshot; a future adapter could add fundamental fields honestly.' },
  { family: 'NEWS_SENTIMENT', reason: 'MarketSnapshot exposes an optional caller-supplied newsSentiment field, but this engine has no news pipeline of its own to populate it from real headlines.' },
  { family: 'MACRO', reason: 'No FX/rates/commodity-curve market access.' },
  { family: 'FOREX', reason: 'No FX broker/market data in Argus today (per CLAUDE.md, Coinbase is crypto-spot only).' },
  { family: 'FUTURES', reason: 'No futures broker/market data in Argus today.' },
  { family: 'CRYPTO', reason: 'Coinbase spot data could back real crypto conditions in a future adapter; no crypto-specific conditions are implemented in this pass.' },
  { family: 'SEASONAL', reason: 'Requires a real multi-year calendar-effect study this engine does not perform; a seasonal condition with no computed evidence would be fabricated.' },
  { family: 'PORTFOLIO', reason: 'Portfolio-level allocation (risk parity, min-variance, etc.) needs a multi-position context this single-symbol engine does not model.' },
  { family: 'RISK', reason: 'Position-sizing rules ARE modeled (core/types.ts PositionSizingRule) but a dedicated risk-strategy family (portfolio heat, correlation-adjusted sizing) needs the same multi-position context as PORTFOLIO above.' },
  { family: 'MULTI_TIMEFRAME', reason: 'MarketSnapshot is single-timeframe; StrategyMetadata.multiTimeframe records intent, but no adapter yet resolves multiple real timeframes into one snapshot.' },
  { family: 'INTRADAY', reason: 'Real gap/VWAP/volume conditions already cover the honestly-supportable intraday mechanics under GAP/MEAN_REVERSION/VOLUME; a dedicated opening-range condition needs intraday bars (see supportResistance.ts openingRange - available:false on daily bars).' },
  { family: 'SCALPING', reason: 'Sub-minute execution/latency assumptions this engine and Argus\'s order path do not model.' },
  { family: 'SWING', reason: 'Swing-holding-period strategies are really TREND/PULLBACK/MEAN_REVERSION at a longer timeframe parameter, not a structurally distinct condition set - covered by tagging, not a separate family template.' },
  { family: 'PULLBACK', reason: 'A real MA-pullback template is a natural next addition (DistanceFromPct against ema20/ema50 already supports it) but is not seeded in this pass - tracked as a real gap, not faked.' },
  { family: 'CANDLESTICK', reason: 'Argus\'s real candlestick detector (indicators/priceAction.ts) is not yet exposed on MarketSnapshot; adding it is a real, scoped next step, not implemented in this pass.' },
  { family: 'FIBONACCI', reason: 'Real Fibonacci levels exist (indicators/supportResistance.ts calculateFibonacciRetracement) but are not yet exposed on MarketSnapshot.levels in this pass.' },
  { family: 'MARKET_STRUCTURE', reason: 'BOS/CHoCH conditions ARE implemented under SMART_MONEY; a dedicated MARKET_STRUCTURE family is redundant with that until swing-point-level detail is exposed separately.' },
  { family: 'PRICE_ACTION', reason: 'Overlaps SMART_MONEY/CANDLESTICK; not separately templated in this pass.' },
];
