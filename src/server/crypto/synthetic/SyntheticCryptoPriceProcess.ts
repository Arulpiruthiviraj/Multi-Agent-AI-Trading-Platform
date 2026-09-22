/**
 * ARGUS Crypto V2 - synthetic crypto price-path generator (2026-09-21 P0 slice). Combines, per
 * bar: (1) a market-wide regime's drift/volatility multiplier (mandate: "correlated-factor
 * process... multiple assets share latent factors"), (2) the asset's loading against the BTC
 * anchor's own return series (mandate: "BTC-led crypto process"), (3) idiosyncratic gaussian
 * noise scaled by the asset's own volatility bucket, and (4) a mean-reversion pull for assets
 * whose ground-truth archetype is MEAN_REVERTING. This covers 4 of the mandate's ~11 named price
 * processes (GBM/drift+vol baseline, regime-switching, correlated-factor, mean-reverting) as one
 * real, unified, causal generator rather than 11 separate toy functions - jump/crash processes
 * are already reachable through the regime state machine's own CRASH regime (a large negative
 * driftBias + volatility multiplier), not a separate mechanism. Adversarial/gap/liquidity-crisis
 * process variants remain backlog (see the session's final report).
 *
 * Every return computed here uses ONLY the current bar's regime and the BTC factor return at the
 * SAME bar index - never a future bar - so this generator is causal by construction. Listing/
 * delisting bar indices bound which bars actually exist for a given asset (mandate: newly-listed
 * assets have short history, delisting candidates disappear before the run ends).
 */
import { SyntheticRandom } from '../../replay/synthetic/SyntheticRandom';
import type { SyntheticCryptoAsset } from './SyntheticCryptoAssetTypes';
import { REGIME_PARAMETERS, type SyntheticCryptoRegime } from './SyntheticCryptoRegimeStateMachine';

export interface SyntheticCryptoBar {
  barIndex: number;
  timestampMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Generates the BTC anchor's own log-return series - the factor every other asset's return
 *  partially depends on. The anchor's own return has no factor dependency (loading is meaningless
 *  against itself), only regime-driven drift/vol plus idiosyncratic noise. */
export function generateBtcFactorReturns(
  rng: SyntheticRandom,
  regimePath: readonly SyntheticCryptoRegime[],
  baseVolatilityPerBar: number,
): number[] {
  return regimePath.map((regime) => {
    const params = REGIME_PARAMETERS[regime];
    return params.driftBias + rng.gaussian() * baseVolatilityPerBar * params.volatilityMultiplier;
  });
}

function meanReversionPull(price: number, anchorPrice: number, strength: number): number {
  if (anchorPrice <= 0 || price <= 0) return 0;
  return strength * Math.log(anchorPrice / price);
}

/**
 * Generates one asset's OHLCV bar series from its own listingBarIndex up to
 * min(delistingBarIndex, regimePath.length). `rng` must be a stream dedicated to this asset (the
 * caller is responsible for giving each asset its own deterministic sub-seed, e.g. derived from
 * populationSeed + assetIndex) so two assets never accidentally share the exact same noise draws.
 */
export function generateSyntheticCryptoPricePath(
  asset: SyntheticCryptoAsset,
  regimePath: readonly SyntheticCryptoRegime[],
  btcFactorReturns: readonly number[],
  rng: SyntheticRandom,
  startTimestampMs: number,
  barIntervalMs: number,
): SyntheticCryptoBar[] {
  const endBar = Math.min(asset.delistingBarIndex ?? regimePath.length, regimePath.length);
  const bars: SyntheticCryptoBar[] = [];
  if (asset.listingBarIndex >= endBar) return bars;

  let price = asset.initialPrice;
  const anchorPrice = asset.initialPrice;
  const isMeanReverting = asset.behavioralArchetype === 'MEAN_REVERTING';
  const isRandom = asset.behavioralArchetype === 'RANDOM';

  for (let i = asset.listingBarIndex; i < endBar; i++) {
    const regime = regimePath[i];
    const params = REGIME_PARAMETERS[regime];
    const idiosyncratic = rng.gaussian() * asset.baseVolatilityPerBar * params.volatilityMultiplier;
    // RANDOM archetype assets deliberately get zero regime drift and zero BTC factor loading
    // applied to the DRIFT term (their whole point is to have no exploitable structure) - they
    // still inherit regime VOLATILITY scaling, since even noise assets trade in a shared vol
    // environment; only the directional bias is suppressed.
    const factorReturn = isRandom ? 0 : asset.btcFactorLoading * btcFactorReturns[i];
    const drift = isRandom ? 0 : params.driftBias;
    const reversion = isMeanReverting ? meanReversionPull(price, anchorPrice, 0.02) : 0;

    const logReturn = drift + factorReturn + reversion + idiosyncratic;
    const open = price;
    price = Math.max(price * Math.exp(logReturn), 1e-9); // price can never hit exactly 0 or go negative
    const close = price;
    const high = Math.max(open, close) * (1 + Math.abs(rng.gaussian()) * asset.baseSpreadPct * 2);
    const low = Math.min(open, close) * (1 - Math.abs(rng.gaussian()) * asset.baseSpreadPct * 2);
    const volume = Math.max(0, 1000 * (1 + Math.abs(idiosyncratic) * 50) * rng.range(0.5, 1.5));

    bars.push({
      barIndex: i,
      timestampMs: startTimestampMs + i * barIntervalMs,
      open,
      high,
      low,
      close,
      volume,
    });
  }

  return bars;
}
