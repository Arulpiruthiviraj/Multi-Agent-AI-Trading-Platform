/**
 * ARGUS Crypto V2 - synthetic crypto population type contracts (2026-09-21 P0 slice of the
 * "Massive Crypto Synthetic Market Simulator & Population Stress-Test Engine" mandate).
 *
 * Distinct from src/server/replay/synthetic/SyntheticMarketDataEngine.ts, which is a real,
 * separate, equity-specific engine (single RTH session, 1-minute bars, intraday U-shaped
 * volume curve, ~10-symbol universe) - none of that shape fits a 24/7, thousands-of-asset,
 * cross-correlated crypto population. This module reuses SyntheticRandom (the same deterministic
 * PRNG) but is otherwise a separate, purpose-built engine, not a fork of the equity one.
 *
 * Isolated, unwired module: nothing in the live spine imports src/server/crypto/synthetic/ (see
 * syntheticCryptoArchitectureBoundary.test.ts). Symbols generated here use the SYN- prefix
 * specifically so they can never collide with a real listed ticker (looksLikeListedTicker() and
 * the production discovery universe never produce SYN-prefixed names).
 */

export type CryptoLiquidityBucket = 'LARGE_CAP' | 'MID_CAP' | 'SMALL_CAP' | 'MICRO_CAP';

export type CryptoVolatilityBucket = 'LOW' | 'MODERATE' | 'HIGH' | 'EXTREME';

export type CryptoCorrelationCluster =
  | 'BTC_CORE'
  | 'ETH_CORE'
  | 'L1'
  | 'L2'
  | 'DEFI'
  | 'MEME'
  | 'STABLECOIN'
  | 'NOISE';

/**
 * The GENERATING process's ground-truth label - what the asset actually IS, not what Argus
 * thinks it is. Never fed into any feature/strategy computation directly; exists only so an
 * evaluator can later ask "did Argus behave differently on a TRENDING asset than a RANDOM one,"
 * per the mandate's ground-truth framework (never expose this to the decision pipeline).
 */
export type CryptoBehavioralArchetype =
  | 'TRENDING'
  | 'MEAN_REVERTING'
  | 'RANDOM'
  | 'NEWLY_LISTED'
  | 'DELISTING_CANDIDATE'
  | 'STABLECOIN_LIKE';

export interface SyntheticCryptoAsset {
  /** Always SYN-prefixed - mechanically distinct from any real listed symbol. */
  syntheticSymbol: string;
  assetId: string;
  baseAsset: string;
  quoteAsset: 'USD';
  liquidityBucket: CryptoLiquidityBucket;
  volatilityBucket: CryptoVolatilityBucket;
  correlationCluster: CryptoCorrelationCluster;
  /** Ground truth only - see the type's own doc comment. */
  behavioralArchetype: CryptoBehavioralArchetype;
  initialPrice: number;
  /** Loading (beta) on the synthetic BTC anchor's return series - 0 for the BTC anchor itself. */
  btcFactorLoading: number;
  /** Bar index (0-based) at which this asset first has data - >0 for NEWLY_LISTED assets, always
   *  0 for the BTC/ETH anchors and most of the population. */
  listingBarIndex: number;
  /** Bar index at which this asset stops trading (delisting) - null if it survives the whole run. */
  delistingBarIndex: number | null;
  /** Base per-bar log-return stdev before any regime multiplier - derived from volatilityBucket,
   *  stored explicitly so it's inspectable without re-deriving it from the bucket label. */
  baseVolatilityPerBar: number;
  /** Base bid/ask spread as a fraction of price under normal liquidity - derived from
   *  liquidityBucket. */
  baseSpreadPct: number;
}

export interface SyntheticCryptoPopulationConfig {
  populationSeed: number;
  populationSize: number;
}

/** The two first-class anchor symbols every population includes, per the mandate's own
 *  requirement that BTC/ETH receive first-class synthetic treatment. */
export const SYNTHETIC_BTC_SYMBOL = 'SYN-BTC-USD';
export const SYNTHETIC_ETH_SYMBOL = 'SYN-ETH-USD';
