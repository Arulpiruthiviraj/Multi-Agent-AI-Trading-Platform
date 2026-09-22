/**
 * ARGUS Crypto V2 - deterministic synthetic crypto population generator (2026-09-21 P0 slice).
 * Pure computation, no I/O: given the same (populationSeed, populationSize), always produces the
 * identical population (reproducibility requirement). Scales linearly in populationSize - the
 * mechanism itself supports the mandate's 1,000/5,000/10,000-asset targets; this session verifies
 * it at a smaller scale (see the test suite) rather than claiming an untested 10,000-asset run.
 */
import { SyntheticRandom } from '../../replay/synthetic/SyntheticRandom';
import {
  type CryptoCorrelationCluster,
  type CryptoLiquidityBucket,
  type CryptoVolatilityBucket,
  type CryptoBehavioralArchetype,
  type SyntheticCryptoAsset,
  type SyntheticCryptoPopulationConfig,
  SYNTHETIC_BTC_SYMBOL,
  SYNTHETIC_ETH_SYMBOL,
} from './SyntheticCryptoAssetTypes';

const NON_ANCHOR_CLUSTERS: readonly { cluster: CryptoCorrelationCluster; weight: number }[] = [
  { cluster: 'L1', weight: 0.15 },
  { cluster: 'L2', weight: 0.12 },
  { cluster: 'DEFI', weight: 0.18 },
  { cluster: 'MEME', weight: 0.2 },
  { cluster: 'STABLECOIN', weight: 0.05 },
  { cluster: 'NOISE', weight: 0.3 },
];

// Realistic long-tail: most synthetic assets are small/micro-cap, large-cap is rare - matches the
// mandate's own "do not make all synthetic coins statistically identical" instruction.
const LIQUIDITY_WEIGHTS: readonly { bucket: CryptoLiquidityBucket; weight: number }[] = [
  { bucket: 'LARGE_CAP', weight: 0.05 },
  { bucket: 'MID_CAP', weight: 0.15 },
  { bucket: 'SMALL_CAP', weight: 0.4 },
  { bucket: 'MICRO_CAP', weight: 0.4 },
];

const CLUSTER_SYMBOL_TAG: Record<CryptoCorrelationCluster, string> = {
  BTC_CORE: 'BTC',
  ETH_CORE: 'ETH',
  L1: 'L1',
  L2: 'L2',
  DEFI: 'DEFI',
  MEME: 'MEME',
  STABLECOIN: 'STBL',
  NOISE: 'ALT',
};

// Annualized-vol-equivalent per-bar stdev bands, loosely matched to real crypto behavior (a
// stablecoin genuinely trades near-flat; a micro-cap meme genuinely gaps hard) - real magnitude
// bands, not a single constant.
const VOLATILITY_BAND: Record<CryptoVolatilityBucket, [number, number]> = {
  LOW: [0.0005, 0.003],
  MODERATE: [0.01, 0.025],
  HIGH: [0.025, 0.05],
  EXTREME: [0.05, 0.12],
};

const SPREAD_BAND: Record<CryptoLiquidityBucket, [number, number]> = {
  LARGE_CAP: [0.0001, 0.0005],
  MID_CAP: [0.0005, 0.0015],
  SMALL_CAP: [0.0015, 0.005],
  MICRO_CAP: [0.005, 0.02],
};

function weightedPick<T extends { weight: number }>(rng: SyntheticRandom, options: readonly T[]): T {
  const total = options.reduce((sum, o) => sum + o.weight, 0);
  let r = rng.range(0, total);
  for (const option of options) {
    r -= option.weight;
    if (r <= 0) return option;
  }
  return options[options.length - 1];
}

function behavioralArchetypeFor(
  rng: SyntheticRandom,
  cluster: CryptoCorrelationCluster,
): CryptoBehavioralArchetype {
  if (cluster === 'STABLECOIN') return 'STABLECOIN_LIKE';
  if (rng.chance(0.08)) return 'NEWLY_LISTED';
  if (rng.chance(0.06)) return 'DELISTING_CANDIDATE';
  if (cluster === 'MEME') return rng.chance(0.5) ? 'RANDOM' : 'TRENDING';
  const roll = rng.next();
  if (roll < 0.35) return 'TRENDING';
  if (roll < 0.65) return 'MEAN_REVERTING';
  return 'RANDOM';
}

function buildNonAnchorAsset(rng: SyntheticRandom, index: number, totalBars: number): SyntheticCryptoAsset {
  const cluster = weightedPick(rng, NON_ANCHOR_CLUSTERS).cluster;
  const liquidityBucket = weightedPick(rng, LIQUIDITY_WEIGHTS).bucket;
  const archetype = behavioralArchetypeFor(rng, cluster);

  const volatilityBucket: CryptoVolatilityBucket =
    archetype === 'STABLECOIN_LIKE'
      ? 'LOW'
      : cluster === 'MEME'
        ? 'EXTREME'
        : liquidityBucket === 'MICRO_CAP'
          ? rng.chance(0.6) ? 'HIGH' : 'EXTREME'
          : liquidityBucket === 'LARGE_CAP'
            ? 'LOW'
            : rng.pick<CryptoVolatilityBucket>(['MODERATE', 'HIGH']);

  const [volLo, volHi] = VOLATILITY_BAND[volatilityBucket];
  const [spreadLo, spreadHi] = SPREAD_BAND[liquidityBucket];

  const btcFactorLoading =
    archetype === 'STABLECOIN_LIKE'
      ? rng.range(-0.02, 0.02)
      : cluster === 'NOISE'
        ? rng.range(-0.1, 0.3)
        : rng.range(0.3, 1.4);

  const listingBarIndex = archetype === 'NEWLY_LISTED' ? Math.floor(totalBars * rng.range(0.5, 0.9)) : 0;
  const delistingBarIndex =
    archetype === 'DELISTING_CANDIDATE' ? Math.floor(totalBars * rng.range(0.6, 0.95)) : null;

  const tag = CLUSTER_SYMBOL_TAG[cluster];
  return {
    syntheticSymbol: `SYN${tag}${String(index).padStart(3, '0')}`,
    assetId: `synthetic-${index}`,
    baseAsset: `${tag}${index}`,
    quoteAsset: 'USD',
    liquidityBucket,
    volatilityBucket,
    correlationCluster: cluster,
    behavioralArchetype: archetype,
    initialPrice: liquidityBucket === 'LARGE_CAP' ? rng.range(10, 500)
      : liquidityBucket === 'MID_CAP' ? rng.range(0.5, 50)
        : liquidityBucket === 'SMALL_CAP' ? rng.range(0.01, 5)
          : rng.range(0.0001, 0.5),
    btcFactorLoading,
    listingBarIndex,
    delistingBarIndex,
    baseVolatilityPerBar: rng.range(volLo, volHi),
    baseSpreadPct: rng.range(spreadLo, spreadHi),
  };
}

/**
 * Generates a deterministic, heterogeneous synthetic crypto population. Index 0 is always the
 * BTC anchor, index 1 is always the ETH anchor (mandate: "BTC and ETH must receive first-class
 * synthetic treatment") - every other asset carries a btcFactorLoading against the BTC anchor's
 * return series, computed later by SyntheticCryptoPriceProcess, never by this generator (this
 * function only assigns the LOADING, not the correlated path itself - single-responsibility).
 */
export function generateSyntheticCryptoPopulation(
  config: SyntheticCryptoPopulationConfig,
  totalBars: number,
): SyntheticCryptoAsset[] {
  const rng = new SyntheticRandom(config.populationSeed);
  const population: SyntheticCryptoAsset[] = [];

  population.push({
    syntheticSymbol: SYNTHETIC_BTC_SYMBOL,
    assetId: 'synthetic-btc-anchor',
    baseAsset: 'BTC',
    quoteAsset: 'USD',
    liquidityBucket: 'LARGE_CAP',
    volatilityBucket: 'HIGH',
    correlationCluster: 'BTC_CORE',
    behavioralArchetype: 'TRENDING',
    initialPrice: 60_000,
    btcFactorLoading: 1.0,
    listingBarIndex: 0,
    delistingBarIndex: null,
    baseVolatilityPerBar: 0.02,
    baseSpreadPct: 0.0002,
  });

  population.push({
    syntheticSymbol: SYNTHETIC_ETH_SYMBOL,
    assetId: 'synthetic-eth-anchor',
    baseAsset: 'ETH',
    quoteAsset: 'USD',
    liquidityBucket: 'LARGE_CAP',
    volatilityBucket: 'HIGH',
    correlationCluster: 'ETH_CORE',
    behavioralArchetype: 'TRENDING',
    initialPrice: 3_000,
    // ETH is real, historically strongly BTC-correlated but not 1:1 - a loading, not an assumed
    // identical path.
    btcFactorLoading: 0.85,
    listingBarIndex: 0,
    delistingBarIndex: null,
    baseVolatilityPerBar: 0.024,
    baseSpreadPct: 0.0003,
  });

  for (let i = 2; i < config.populationSize; i++) {
    population.push(buildNonAnchorAsset(rng, i, totalBars));
  }

  return population;
}
