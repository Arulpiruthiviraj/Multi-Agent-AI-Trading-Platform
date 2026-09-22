/**
 * ARGUS Crypto V2 - synthetic order-book snapshot generator (2026-09-21). Deterministic given a
 * seed + the asset's liquidity bucket + current price + a volatility multiplier (regime-aware:
 * spread/depth respond to volatility, per the mandate). Pure computation, no persistence.
 */
import { SyntheticRandom } from '../../replay/synthetic/SyntheticRandom';
import type { CryptoLiquidityBucket } from './SyntheticCryptoAssetTypes';

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface SyntheticOrderBookSnapshot {
  bestBid: number;
  bestAsk: number;
  spread: number;
  spreadPct: number;
  bidLevels: OrderBookLevel[];
  askLevels: OrderBookLevel[];
  totalBidDepth: number;
  totalAskDepth: number;
}

const BASE_SPREAD_PCT: Record<CryptoLiquidityBucket, number> = {
  LARGE_CAP: 0.0002,
  MID_CAP: 0.0008,
  SMALL_CAP: 0.003,
  MICRO_CAP: 0.012,
};

const BASE_TOP_OF_BOOK_SIZE_USD: Record<CryptoLiquidityBucket, number> = {
  LARGE_CAP: 500_000,
  MID_CAP: 50_000,
  SMALL_CAP: 5_000,
  MICRO_CAP: 500,
};

const LEVEL_COUNT = 5;
/** Each level roughly this fraction deeper/thinner than the one before it - a realistic decaying
 *  depth profile rather than uniform size at every level. */
const LEVEL_DEPTH_DECAY = 0.7;
/** Each level this many spread-widths further from the touch. */
const LEVEL_PRICE_STEP_SPREAD_MULTIPLIER = 1.5;

/**
 * @param volatilityMultiplier current regime's volatility multiplier (1.0 = baseline) - both
 *   spread and depth respond to it: higher volatility widens spread and thins depth (liquidity
 *   providers pull back exactly when it's riskiest to quote tight), matching real market
 *   microstructure behavior, not just price volatility alone.
 */
export function generateOrderBookSnapshot(
  rng: SyntheticRandom,
  midPrice: number,
  liquidityBucket: CryptoLiquidityBucket,
  volatilityMultiplier: number,
): SyntheticOrderBookSnapshot {
  const baseSpreadPct = BASE_SPREAD_PCT[liquidityBucket];
  // Spread widens with volatility but never collapses to zero even at very low vol.
  const spreadPct = baseSpreadPct * Math.max(0.5, volatilityMultiplier) * rng.range(0.85, 1.15);
  const spread = midPrice * spreadPct;
  const bestBid = midPrice - spread / 2;
  const bestAsk = midPrice + spread / 2;

  // Depth thins as volatility rises - inverse relationship, floored so it never hits zero.
  const depthFactor = Math.max(0.15, 1 / Math.max(0.5, volatilityMultiplier));
  const topOfBookSizeUsd = BASE_TOP_OF_BOOK_SIZE_USD[liquidityBucket] * depthFactor;

  const bidLevels: OrderBookLevel[] = [];
  const askLevels: OrderBookLevel[] = [];
  let bidSizeUsd = topOfBookSizeUsd;
  let askSizeUsd = topOfBookSizeUsd;

  for (let level = 0; level < LEVEL_COUNT; level++) {
    const priceOffset = spread * LEVEL_PRICE_STEP_SPREAD_MULTIPLIER * level;
    const bidPrice = bestBid - priceOffset;
    const askPrice = bestAsk + priceOffset;
    bidLevels.push({ price: bidPrice, size: Math.max(0, (bidSizeUsd / bidPrice) * rng.range(0.8, 1.2)) });
    askLevels.push({ price: askPrice, size: Math.max(0, (askSizeUsd / askPrice) * rng.range(0.8, 1.2)) });
    bidSizeUsd *= LEVEL_DEPTH_DECAY;
    askSizeUsd *= LEVEL_DEPTH_DECAY;
  }

  return {
    bestBid,
    bestAsk,
    spread,
    spreadPct,
    bidLevels,
    askLevels,
    totalBidDepth: bidLevels.reduce((s, l) => s + l.size * l.price, 0),
    totalAskDepth: askLevels.reduce((s, l) => s + l.size * l.price, 0),
  };
}

/** A degenerate, one-sided book - liquidity withdrawal / crisis scenario (mandate section 12). */
export function generateOneSidedBook(
  rng: SyntheticRandom,
  midPrice: number,
  liquidityBucket: CryptoLiquidityBucket,
  side: 'BID_ONLY' | 'ASK_ONLY',
): SyntheticOrderBookSnapshot {
  const snapshot = generateOrderBookSnapshot(rng, midPrice, liquidityBucket, 4.0);
  if (side === 'BID_ONLY') {
    return { ...snapshot, askLevels: [], totalAskDepth: 0, bestAsk: Number.POSITIVE_INFINITY, spread: Number.POSITIVE_INFINITY, spreadPct: Number.POSITIVE_INFINITY };
  }
  return { ...snapshot, bidLevels: [], totalBidDepth: 0, bestBid: 0, spread: Number.POSITIVE_INFINITY, spreadPct: Number.POSITIVE_INFINITY };
}
