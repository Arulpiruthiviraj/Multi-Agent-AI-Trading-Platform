/**
 * ==========================================================
 * Module: quant/indicators/smc
 *
 * Purpose:
 * Smart Money Concepts / ICT-style *pattern classification* over real OHLC bars.
 *
 * Reuses (does not fork):
 *   detectSwingPoints / detectMarketStructure (HH, HL, LH, LL, BOS, CHoCH)
 *   detectFalseBreakout (close beyond a level then close back)
 *
 * Definitions used here (one explicit convention so the engine is reviewable):
 *   Buy-side liquidity  = last swing high (or equal highs within config tolerance)
 *   Sell-side liquidity = last swing low (or equal lows)
 *   Sweep               = wick THROUGH that pool in the lookback window, CLOSE back inside
 *                         (distinct from a confirmed close-beyond breakout)
 *   Displacement        = last bar range ≥ config multiple of the prior average range
 *   Bullish FVG         = candle1.high < candle3.low (3-candle imbalance)
 *   Bearish FVG         = candle1.low > candle3.high
 *   Bullish order block = last bearish candle before an UP displacement (full candle [low, high])
 *   Bearish order block = last bullish candle before a DOWN displacement
 *   Trap                = sweep or false-breakout pattern. isIntentionalManipulation is ALWAYS
 *                         false — order-flow, stops, and volatility can print the same shape.
 *
 * Sweep ≠ trade. isTradeSignal is a TypeScript literal `false`. Confirmation (CHoCH, etc.)
 * lives on the SMC_LIQUIDITY_SWEEP strategy, which is experimental (QUANT_SMC_STRATEGY_ENABLED).
 *
 * Thresholds: config/smcConfluence.json (not module literals).
 * ==========================================================
 */
import { Bar } from '../../engines/backtest/HistoricalDataGateway';
import { detectSwingPoints, detectMarketStructure, MarketStructureResult, SwingPoint } from './trend';
import { detectFalseBreakout } from './priceAction';
import { smcConfluence } from '../../config/smcConfluence';

export interface LiquidityPool {
  price: number;
  kind: 'SWING_HIGH' | 'SWING_LOW' | 'EQUAL_HIGHS' | 'EQUAL_LOWS';
}

export interface SmcLiquidity {
  buySide: LiquidityPool | null;
  sellSide: LiquidityPool | null;
  equalHighs: boolean;
  equalLows: boolean;
}

export type SweepKind = 'BUY_SIDE_SWEPT' | 'SELL_SIDE_SWEPT' | 'NONE';

export interface SmcSweep {
  kind: SweepKind;
  isTradeSignal: false;
  sweptLevel: number | null;
  sweepExtreme: number | null;
  closedBackInside: boolean;
  detail: string;
}

export interface SmcDisplacement {
  present: boolean;
  direction: 'UP' | 'DOWN' | null;
  rangeMultiple: number | null;
  barIndex: number | null;
}

export interface SmcZone {
  side: 'BULLISH' | 'BEARISH' | null;
  low: number | null;
  high: number | null;
  overlappingPrice: boolean;
  filled: boolean | null;
}

export type TrapKind = 'BULL_TRAP' | 'BEAR_TRAP' | 'NONE';

export interface SmcTrap {
  kind: TrapKind;
  isIntentionalManipulation: false;
  detail: string;
}

export interface SmcFeatures {
  structure: MarketStructureResult;
  liquidity: SmcLiquidity;
  sweep: SmcSweep;
  displacement: SmcDisplacement;
  orderBlock: SmcZone;
  fairValueGap: SmcZone;
  trap: SmcTrap;
}

function withinPct(a: number, b: number, tolerancePct: number): boolean {
  if (a === 0 && b === 0) return true;
  const mid = (Math.abs(a) + Math.abs(b)) / 2;
  if (mid === 0) return false;
  return (Math.abs(a - b) / mid) * 100 <= tolerancePct;
}

/** Two most recent same-type swings within `tolerancePct` of each other (equal highs / equal lows). */
export function detectEqualSwingLevels(swings: SwingPoint[], type: 'high' | 'low', tolerancePct: number): boolean {
  const same = swings.filter(s => s.type === type);
  if (same.length < 2) return false;
  const last = same[same.length - 1];
  const prior = same[same.length - 2];
  return withinPct(last.price, prior.price, tolerancePct);
}

/** Map last swing high/low to buy-side / sell-side liquidity pools. Optional precomputed swings avoid a second fractal pass. */
export function detectLiquidity(bars: Bar[], swings?: SwingPoint[]): SmcLiquidity {
  const points = swings ?? detectSwingPoints(bars);
  const highs = points.filter(s => s.type === 'high');
  const lows = points.filter(s => s.type === 'low');
  const lastHigh = highs.length ? highs[highs.length - 1] : null;
  const lastLow = lows.length ? lows[lows.length - 1] : null;
  const equalHighs = detectEqualSwingLevels(points, 'high', smcConfluence.equalLevelTolerancePct);
  const equalLows = detectEqualSwingLevels(points, 'low', smcConfluence.equalLevelTolerancePct);

  return {
    buySide: lastHigh
      ? { price: lastHigh.price, kind: equalHighs ? 'EQUAL_HIGHS' : 'SWING_HIGH' }
      : null,
    sellSide: lastLow
      ? { price: lastLow.price, kind: equalLows ? 'EQUAL_LOWS' : 'SWING_LOW' }
      : null,
    equalHighs,
    equalLows,
  };
}

/**
 * Wick-through liquidity with a close back on the original side.
 * Distinct from detectFalseBreakout (which requires a prior CLOSE beyond the level).
 * Never a trade signal by itself.
 */
export function detectLiquiditySweep(bars: Bar[], liquidity: SmcLiquidity): SmcSweep {
  const lookback = Math.max(1, Math.floor(smcConfluence.sweepLookbackBars));
  if (bars.length < 2) {
    return {
      kind: 'NONE', isTradeSignal: false, sweptLevel: null, sweepExtreme: null,
      closedBackInside: false, detail: 'INSUFFICIENT_DATA',
    };
  }
  const window = bars.slice(-lookback);
  const last = bars[bars.length - 1];

  if (liquidity.buySide) {
    const level = liquidity.buySide.price;
    const extreme = Math.max(...window.map(b => b.high));
    const wickedThrough = window.some(b => b.high > level);
    const closedBack = last.close < level;
    if (wickedThrough && closedBack) {
      return {
        kind: 'BUY_SIDE_SWEPT',
        isTradeSignal: false,
        sweptLevel: level,
        sweepExtreme: extreme,
        closedBackInside: true,
        detail: 'Wick beyond buy-side liquidity with close back below the level. Feature only — not a SELL.',
      };
    }
  }

  if (liquidity.sellSide) {
    const level = liquidity.sellSide.price;
    const extreme = Math.min(...window.map(b => b.low));
    const wickedThrough = window.some(b => b.low < level);
    const closedBack = last.close > level;
    if (wickedThrough && closedBack) {
      return {
        kind: 'SELL_SIDE_SWEPT',
        isTradeSignal: false,
        sweptLevel: level,
        sweepExtreme: extreme,
        closedBackInside: true,
        detail: 'Wick beyond sell-side liquidity with close back above the level. Feature only — not a BUY.',
      };
    }
  }

  return {
    kind: 'NONE', isTradeSignal: false, sweptLevel: null, sweepExtreme: null,
    closedBackInside: false, detail: 'NO_SWEEP',
  };
}

/** Last-bar range vs average range of the prior `lookback` bars. Direction from close vs open. */
export function detectDisplacement(bars: Bar[], lookback: number = 10): SmcDisplacement {
  const multiple = smcConfluence.displacementRangeMultiple;
  if (bars.length < lookback + 1) {
    return { present: false, direction: null, rangeMultiple: null, barIndex: null };
  }
  const lastIdx = bars.length - 1;
  const last = bars[lastIdx];
  const lastRange = last.high - last.low;
  const prior = bars.slice(lastIdx - lookback, lastIdx).map(b => b.high - b.low);
  const avg = prior.reduce((a, b) => a + b, 0) / prior.length;
  if (avg === 0) return { present: false, direction: null, rangeMultiple: null, barIndex: null };
  const rangeMultiple = lastRange / avg;
  if (rangeMultiple < multiple) {
    return { present: false, direction: null, rangeMultiple, barIndex: lastIdx };
  }
  const direction: 'UP' | 'DOWN' = last.close >= last.open ? 'UP' : 'DOWN';
  return { present: true, direction, rangeMultiple, barIndex: lastIdx };
}

/** Most recent 3-candle FVG walking backward from the last bar. `filled` uses bars AFTER the pattern only (no look-ahead). */
export function detectFairValueGap(bars: Bar[], currentPrice: number): SmcZone {
  const empty: SmcZone = { side: null, low: null, high: null, overlappingPrice: false, filled: null };
  if (bars.length < 3) return empty;

  for (let i = bars.length - 1; i >= 2; i--) {
    const c1 = bars[i - 2];
    const c3 = bars[i];
    let side: 'BULLISH' | 'BEARISH' | null = null;
    let low = 0;
    let high = 0;
    if (c1.high < c3.low) {
      side = 'BULLISH';
      low = c1.high;
      high = c3.low;
    } else if (c1.low > c3.high) {
      side = 'BEARISH';
      low = c3.high;
      high = c1.low;
    }
    if (!side) continue;

    const after = bars.slice(i + 1);
    const filled = after.some(b => (side === 'BULLISH' ? b.low <= low : b.high >= high));
    const overlappingPrice = currentPrice >= low && currentPrice <= high;
    return { side, low, high, overlappingPrice, filled };
  }
  return empty;
}

/** Opposite-color candle in the 8 bars before a detected displacement. Zone is that candle's high/low. */
export function detectOrderBlock(bars: Bar[], displacement: SmcDisplacement, currentPrice: number): SmcZone {
  const empty: SmcZone = { side: null, low: null, high: null, overlappingPrice: false, filled: null };
  if (!displacement.present || displacement.barIndex === null || displacement.direction === null) return empty;

  const dispIdx = displacement.barIndex;
  const wantBearishCandle = displacement.direction === 'UP';
  for (let i = dispIdx - 1; i >= Math.max(0, dispIdx - 8); i--) {
    const c = bars[i];
    const bearish = c.close < c.open;
    const bullish = c.close > c.open;
    if (wantBearishCandle && bearish) {
      const low = c.low;
      const high = c.high;
      return {
        side: 'BULLISH',
        low,
        high,
        overlappingPrice: currentPrice >= low && currentPrice <= high,
        filled: null,
      };
    }
    if (!wantBearishCandle && bullish) {
      const low = c.low;
      const high = c.high;
      return {
        side: 'BEARISH',
        low,
        high,
        overlappingPrice: currentPrice >= low && currentPrice <= high,
        filled: null,
      };
    }
  }
  return empty;
}

/**
 * Pattern label for a failed breakout / sweep-reversal. Never proof of "smart money" intent.
 */
export function classifyTrap(
  bars: Bar[],
  liquidity: SmcLiquidity,
  sweep: SmcSweep,
): SmcTrap {
  const noneDetail = 'No failed-breakout / sweep-reversal pattern on the latest bars.';
  const disclaimer = 'Pattern classification only — not evidence of intentional institutional manipulation.';

  if (sweep.kind === 'BUY_SIDE_SWEPT') {
    return { kind: 'BULL_TRAP', isIntentionalManipulation: false, detail: `Wick sweep of buy-side liquidity then close back inside. ${disclaimer}` };
  }
  if (sweep.kind === 'SELL_SIDE_SWEPT') {
    return { kind: 'BEAR_TRAP', isIntentionalManipulation: false, detail: `Wick sweep of sell-side liquidity then close back inside. ${disclaimer}` };
  }

  if (liquidity.buySide && detectFalseBreakout(bars, liquidity.buySide.price, 'UP')) {
    return { kind: 'BULL_TRAP', isIntentionalManipulation: false, detail: `Close beyond then back below buy-side liquidity (false breakout). ${disclaimer}` };
  }
  if (liquidity.sellSide && detectFalseBreakout(bars, liquidity.sellSide.price, 'DOWN')) {
    return { kind: 'BEAR_TRAP', isIntentionalManipulation: false, detail: `Close beyond then back above sell-side liquidity (false breakdown). ${disclaimer}` };
  }

  return { kind: 'NONE', isIntentionalManipulation: false, detail: noneDetail };
}

/** Single snapshot for StrategyContext.smc / feature engine. Pure; same bars → same result. */
export function computeSmcFeatures(bars: Bar[]): SmcFeatures {
  const structure = detectMarketStructure(bars);
  const swings = detectSwingPoints(bars);
  const liquidity = detectLiquidity(bars, swings);
  const sweep = detectLiquiditySweep(bars, liquidity);
  const displacement = detectDisplacement(bars);
  const currentPrice = bars.length ? bars[bars.length - 1].close : 0;
  const fairValueGap = detectFairValueGap(bars, currentPrice);
  const orderBlock = detectOrderBlock(bars, displacement, currentPrice);
  const trap = classifyTrap(bars, liquidity, sweep);

  return { structure, liquidity, sweep, displacement, orderBlock, fairValueGap, trap };
}
