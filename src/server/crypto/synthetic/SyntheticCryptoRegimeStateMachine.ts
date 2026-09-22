/**
 * ARGUS Crypto V2 - synthetic regime state-transition machine (2026-09-21 P0 slice). Regimes
 * evolve through a configurable Markov chain, not an independent random label per bar (mandate:
 * "Do not randomly assign a regime independently to every bar. Use a state-transition
 * mechanism."). Taxonomy intersects with CryptoRegimeEngine.java's real classification labels
 * (TRENDING_BULL/TRENDING_BEAR/RANGE/VOLATILITY_EXPANSION/VOLATILITY_COMPRESSION) plus two
 * stress-only regimes (CRASH/RECOVERY) the classifier doesn't itself emit but the mandate's
 * adversarial scenarios need to drive price generation.
 */
import { SyntheticRandom } from '../../replay/synthetic/SyntheticRandom';

export type SyntheticCryptoRegime =
  | 'TRENDING_BULL'
  | 'TRENDING_BEAR'
  | 'RANGE'
  | 'VOLATILITY_EXPANSION'
  | 'VOLATILITY_COMPRESSION'
  | 'CRASH'
  | 'RECOVERY';

export interface RegimeParameters {
  /** Per-bar log-return drift bias applied on top of the asset's own idiosyncratic/factor
   *  return - 0 for a regime with no directional bias. */
  driftBias: number;
  /** Multiplier on the asset's baseVolatilityPerBar while this regime is active. */
  volatilityMultiplier: number;
}

export const REGIME_PARAMETERS: Record<SyntheticCryptoRegime, RegimeParameters> = {
  TRENDING_BULL: { driftBias: 0.0015, volatilityMultiplier: 1.0 },
  TRENDING_BEAR: { driftBias: -0.0015, volatilityMultiplier: 1.1 },
  RANGE: { driftBias: 0, volatilityMultiplier: 0.8 },
  VOLATILITY_EXPANSION: { driftBias: 0, volatilityMultiplier: 2.2 },
  VOLATILITY_COMPRESSION: { driftBias: 0, volatilityMultiplier: 0.4 },
  CRASH: { driftBias: -0.03, volatilityMultiplier: 3.5 },
  RECOVERY: { driftBias: 0.01, volatilityMultiplier: 1.8 },
};

/** Row-stochastic transition matrix: TRANSITION_MATRIX[from][to] is the probability of moving to
 *  `to` on the NEXT bar given the chain is currently in `from`. Each row must sum to 1 (enforced
 *  by a test, not just asserted here). Values are a reviewed, reasonable starting point - not
 *  claimed to match real crypto regime persistence statistics, since no real regime-labeled
 *  historical dataset backs them yet (same honesty standard as CryptoRegimeEngine's own
 *  DEFAULT_THRESHOLDS). */
export const DEFAULT_TRANSITION_MATRIX: Record<SyntheticCryptoRegime, Record<SyntheticCryptoRegime, number>> = {
  TRENDING_BULL: {
    TRENDING_BULL: 0.88, TRENDING_BEAR: 0.02, RANGE: 0.04, VOLATILITY_EXPANSION: 0.03,
    VOLATILITY_COMPRESSION: 0.02, CRASH: 0.01, RECOVERY: 0,
  },
  TRENDING_BEAR: {
    TRENDING_BULL: 0.02, TRENDING_BEAR: 0.85, RANGE: 0.04, VOLATILITY_EXPANSION: 0.04,
    VOLATILITY_COMPRESSION: 0.01, CRASH: 0.04, RECOVERY: 0,
  },
  RANGE: {
    TRENDING_BULL: 0.08, TRENDING_BEAR: 0.08, RANGE: 0.7, VOLATILITY_EXPANSION: 0.06,
    VOLATILITY_COMPRESSION: 0.08, CRASH: 0, RECOVERY: 0,
  },
  VOLATILITY_EXPANSION: {
    TRENDING_BULL: 0.15, TRENDING_BEAR: 0.15, RANGE: 0.15, VOLATILITY_EXPANSION: 0.4,
    VOLATILITY_COMPRESSION: 0.05, CRASH: 0.1, RECOVERY: 0,
  },
  VOLATILITY_COMPRESSION: {
    TRENDING_BULL: 0.1, TRENDING_BEAR: 0.1, RANGE: 0.25, VOLATILITY_EXPANSION: 0.35,
    VOLATILITY_COMPRESSION: 0.2, CRASH: 0, RECOVERY: 0,
  },
  CRASH: {
    TRENDING_BULL: 0, TRENDING_BEAR: 0.15, RANGE: 0, VOLATILITY_EXPANSION: 0.1,
    VOLATILITY_COMPRESSION: 0, CRASH: 0.25, RECOVERY: 0.5,
  },
  RECOVERY: {
    TRENDING_BULL: 0.35, TRENDING_BEAR: 0.05, RANGE: 0.15, VOLATILITY_EXPANSION: 0.15,
    VOLATILITY_COMPRESSION: 0.05, CRASH: 0.05, RECOVERY: 0.2,
  },
};

const REGIME_ORDER: readonly SyntheticCryptoRegime[] = [
  'TRENDING_BULL', 'TRENDING_BEAR', 'RANGE', 'VOLATILITY_EXPANSION', 'VOLATILITY_COMPRESSION', 'CRASH', 'RECOVERY',
];

function nextRegime(
  rng: SyntheticRandom,
  current: SyntheticCryptoRegime,
  matrix: Record<SyntheticCryptoRegime, Record<SyntheticCryptoRegime, number>>,
): SyntheticCryptoRegime {
  const row = matrix[current];
  let r = rng.next();
  for (const regime of REGIME_ORDER) {
    r -= row[regime];
    if (r <= 0) return regime;
  }
  return current; // floating-point fallback - row should sum to ~1
}

/**
 * Generates the full deterministic regime path for `totalBars` bars, starting from
 * `initialRegime`. Each bar's regime depends ONLY on the previous bar's regime and this RNG
 * stream's next draw - never on future information (causal by construction: it's a strict
 * left-to-right walk).
 */
export function generateRegimePath(
  rng: SyntheticRandom,
  totalBars: number,
  initialRegime: SyntheticCryptoRegime = 'RANGE',
  matrix: Record<SyntheticCryptoRegime, Record<SyntheticCryptoRegime, number>> = DEFAULT_TRANSITION_MATRIX,
): SyntheticCryptoRegime[] {
  const path: SyntheticCryptoRegime[] = new Array(totalBars);
  let current = initialRegime;
  for (let i = 0; i < totalBars; i++) {
    path[i] = current;
    current = nextRegime(rng, current, matrix);
  }
  return path;
}
