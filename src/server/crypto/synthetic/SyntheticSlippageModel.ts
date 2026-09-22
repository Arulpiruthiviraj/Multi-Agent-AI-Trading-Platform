/**
 * ARGUS Crypto V2 - synthetic slippage model (2026-09-21). Not a single constant number (mandate
 * section 13: "Do not use a single constant slippage number") - slippage is a function of order
 * size relative to available depth, spread, and a liquidity-bucket-specific impact coefficient.
 * Deterministic given the inputs (no hidden randomness) so the same order against the same book
 * always produces the same slippage estimate.
 */
import type { CryptoLiquidityBucket } from './SyntheticCryptoAssetTypes';
import type { SyntheticOrderBookSnapshot } from './SyntheticOrderBook';

export type MarketLiquidityCondition = 'LIQUID' | 'NORMAL' | 'ILLIQUID' | 'CRISIS';

const IMPACT_COEFFICIENT: Record<CryptoLiquidityBucket, number> = {
  LARGE_CAP: 0.05,
  MID_CAP: 0.15,
  SMALL_CAP: 0.4,
  MICRO_CAP: 1.0,
};

const CONDITION_MULTIPLIER: Record<MarketLiquidityCondition, number> = {
  LIQUID: 0.6,
  NORMAL: 1.0,
  ILLIQUID: 2.5,
  CRISIS: 6.0,
};

export function classifyLiquidityCondition(volatilityMultiplier: number): MarketLiquidityCondition {
  if (volatilityMultiplier >= 3.0) return 'CRISIS';
  if (volatilityMultiplier >= 1.8) return 'ILLIQUID';
  if (volatilityMultiplier <= 0.6) return 'LIQUID';
  return 'NORMAL';
}

export interface SlippageEstimate {
  /** Half-spread cost alone, in price units - paid even for an infinitesimally small order. */
  halfSpreadCost: number;
  /** Additional cost from consuming book depth beyond the touch, in price units. */
  marketImpactCost: number;
  /** halfSpreadCost + marketImpactCost, in price units. */
  totalSlippage: number;
  /** totalSlippage expressed as a fraction of the arrival mid price. */
  totalSlippagePct: number;
  liquidityCondition: MarketLiquidityCondition;
}

/**
 * @param orderNotionalUsd  the order's size in quote-currency terms
 * @param book              the order book being executed against (side-appropriate depth is used)
 * @param side              BUY consumes ask depth, SELL consumes bid depth
 */
export function estimateSlippage(
  orderNotionalUsd: number,
  book: SyntheticOrderBookSnapshot,
  side: 'BUY' | 'SELL',
  liquidityBucket: CryptoLiquidityBucket,
  volatilityMultiplier: number,
): SlippageEstimate {
  const midPrice = (book.bestBid + book.bestAsk) / 2;
  const halfSpreadCost = book.spread / 2;
  const relevantDepth = side === 'BUY' ? book.totalAskDepth : book.totalBidDepth;
  const liquidityCondition = classifyLiquidityCondition(volatilityMultiplier);
  const conditionMultiplier = CONDITION_MULTIPLIER[liquidityCondition];
  const impactCoefficient = IMPACT_COEFFICIENT[liquidityBucket];

  // Participation rate: how much of the available book depth this order consumes. A larger
  // fraction consumed -> a real, nonlinear (square-root-shaped) market-impact cost, matching the
  // well-known square-root market impact convention (impact ~ sqrt(participation)) rather than a
  // linear or fixed cost.
  const participation = relevantDepth > 0 ? Math.min(orderNotionalUsd / relevantDepth, 10) : 10;
  const marketImpactCost = midPrice * impactCoefficient * conditionMultiplier * Math.sqrt(Math.max(participation, 0)) * 0.01;

  const totalSlippage = halfSpreadCost + marketImpactCost;
  return {
    halfSpreadCost,
    marketImpactCost,
    totalSlippage,
    totalSlippagePct: midPrice > 0 ? totalSlippage / midPrice : 0,
    liquidityCondition,
  };
}
