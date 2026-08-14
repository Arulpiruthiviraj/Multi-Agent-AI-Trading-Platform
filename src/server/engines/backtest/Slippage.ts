/**
 * ==========================================================
 * Module: Slippage
 *
 * Purpose:
 * Phase 2B of FINAL_ANALYSIS.md's 4-phase remediation plan - dynamic, volatility- and size-scaled
 * slippage, replacing BacktestEngine's previous flat 5bps symmetric spread (FINAL_ANALYSIS.md
 * 15.9's own flagged gap: "not scaled by size/volatility/liquidity").
 *
 * Real, standard market-impact convention (a simplified linear-impact model, in the spirit of
 * Almgren-Chriss): total slippage = a base spread floor + a volatility component (real 14-period
 * Wilder ATR relative to price, via TechnicalIndicators.calculateATR - the same real
 * implementation TechnicalAgent/BacktestEngine already use elsewhere, not a new formula) + a
 * participation-rate component (order size relative to the bar's own real trading volume - a
 * larger order relative to typical volume should cost more to fill, not the same flat cost as a
 * tiny one). Never fabricates volatility/volume - both are read directly from the real bars
 * already loaded for this backtest.
 * ==========================================================
 */
import { TechnicalIndicators } from '../TechnicalIndicators';

export const BASE_SLIPPAGE_PCT = 0.0005; // floor - matches the old flat spread as a lower bound, not a replacement for it
export const ATR_SLIPPAGE_MULTIPLIER = 0.05; // fraction of (ATR/price) added as slippage
export const SIZE_IMPACT_MULTIPLIER = 0.5; // fraction of (orderShares/barVolume) added as slippage
const MAX_SLIPPAGE_PCT = 0.05; // sanity ceiling - an illiquid/zero-volume bar must not imply near-infinite slippage

export interface SlippageContext {
  highs: number[];
  lows: number[];
  closes: number[];
  currentPrice: number;
  orderShares: number;
  barVolume: number;
}

/**
 * Real dynamic slippage percentage for one simulated fill. Always at least BASE_SLIPPAGE_PCT;
 * grows with real measured volatility (ATR/price) and real participation rate (order size /
 * that bar's real traded volume).
 */
export function calculateDynamicSlippagePct(ctx: SlippageContext): number {
  const atr = TechnicalIndicators.calculateATR(ctx.highs, ctx.lows, ctx.closes);
  const atrComponent = ctx.currentPrice > 0 ? (atr / ctx.currentPrice) * ATR_SLIPPAGE_MULTIPLIER : 0;
  const sizeComponent = ctx.barVolume > 0 ? Math.min(1, ctx.orderShares / ctx.barVolume) * SIZE_IMPACT_MULTIPLIER : 0;
  return Math.min(MAX_SLIPPAGE_PCT, BASE_SLIPPAGE_PCT + atrComponent + sizeComponent);
}
