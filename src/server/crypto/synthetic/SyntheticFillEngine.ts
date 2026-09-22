/**
 * ARGUS Crypto V2 - synthetic fill engine (2026-09-21). Produces realistic fills from arrival
 * price + the order book + the slippage model, preserving arrival_price immutably (mandate: "Do
 * not overwrite immutable arrival price" - the same invariant real Argus already enforces via
 * trades.arrival_price, written once at order insert). Pure functions - no persistence, no
 * broker state; SyntheticCryptoBroker owns state and calls into this module.
 */
import { SyntheticRandom } from '../../replay/synthetic/SyntheticRandom';
import { estimateSlippage, type MarketLiquidityCondition } from './SyntheticSlippageModel';
import type { SyntheticOrderBookSnapshot } from './SyntheticOrderBook';
import type { CryptoLiquidityBucket } from './SyntheticCryptoAssetTypes';

export interface FillResult {
  /** Never recomputed or overwritten once set - the same immutability guarantee as the real
   *  trades.arrival_price column. */
  readonly arrivalPrice: number;
  actualFillPrice: number;
  /** Positive = the fill was worse than arrival price for the order's side (real cost paid). */
  signedSlippage: number;
  signedSlippagePct: number;
  fillQuantity: number;
  remainingQuantity: number;
  latencyMs: number;
  liquidityCondition: MarketLiquidityCondition;
  outcome: 'FULL_FILL' | 'PARTIAL_FILL' | 'REJECTED';
}

const PARTIAL_FILL_PROBABILITY: Record<MarketLiquidityCondition, number> = {
  LIQUID: 0.02,
  NORMAL: 0.08,
  ILLIQUID: 0.35,
  CRISIS: 0.65,
};

const REJECT_PROBABILITY: Record<MarketLiquidityCondition, number> = {
  LIQUID: 0.001,
  NORMAL: 0.005,
  ILLIQUID: 0.03,
  CRISIS: 0.15,
};

export function simulateFill(
  rng: SyntheticRandom,
  side: 'BUY' | 'SELL',
  requestedQuantity: number,
  arrivalPrice: number,
  book: SyntheticOrderBookSnapshot,
  liquidityBucket: CryptoLiquidityBucket,
  volatilityMultiplier: number,
): FillResult {
  const orderNotionalUsd = requestedQuantity * arrivalPrice;
  const slippage = estimateSlippage(orderNotionalUsd, book, side, liquidityBucket, volatilityMultiplier);
  const latencyMs = Math.round(20 + rng.range(0, 180) * (slippage.liquidityCondition === 'CRISIS' ? 4 : 1));

  if (rng.chance(REJECT_PROBABILITY[slippage.liquidityCondition])) {
    return {
      arrivalPrice,
      actualFillPrice: arrivalPrice,
      signedSlippage: 0,
      signedSlippagePct: 0,
      fillQuantity: 0,
      remainingQuantity: requestedQuantity,
      latencyMs,
      liquidityCondition: slippage.liquidityCondition,
      outcome: 'REJECTED',
    };
  }

  const isPartial = rng.chance(PARTIAL_FILL_PROBABILITY[slippage.liquidityCondition]);
  const fillFraction = isPartial ? rng.range(0.2, 0.85) : 1.0;
  const fillQuantity = requestedQuantity * fillFraction;
  const remainingQuantity = requestedQuantity - fillQuantity;

  // BUY pays UP from arrival price by the slippage; SELL receives DOWN from arrival price.
  const direction = side === 'BUY' ? 1 : -1;
  const actualFillPrice = arrivalPrice + direction * slippage.totalSlippage;
  const signedSlippage = direction * slippage.totalSlippage;

  return {
    arrivalPrice,
    actualFillPrice,
    signedSlippage,
    signedSlippagePct: arrivalPrice > 0 ? signedSlippage / arrivalPrice : 0,
    fillQuantity,
    remainingQuantity,
    latencyMs,
    liquidityCondition: slippage.liquidityCondition,
    outcome: isPartial ? 'PARTIAL_FILL' : 'FULL_FILL',
  };
}
