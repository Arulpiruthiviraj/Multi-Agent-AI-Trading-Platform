/**
 * Research fill-cost overlay. Never cheaper than global researchSafety costs.
 * Never calls OMS. Zero-cost still cannot promote.
 */
import { loadCanonicalCosts, type CanonicalFillCosts } from '../research/canonicalNextBarEngine';
import { getAssetProfile, isPennyStockEnabled, type MultiAssetClass } from '../config/multiAsset';
import { isPennyOrMicro } from './AssetClassifier';

export function loadCanonicalCostsForAsset(assetClass?: MultiAssetClass | string | null): CanonicalFillCosts {
  const base = loadCanonicalCosts();
  if (!isPennyStockEnabled() || !assetClass || !isPennyOrMicro(assetClass as MultiAssetClass)) {
    return base;
  }
  const extra = getAssetProfile(assetClass as MultiAssetClass).researchCosts;
  if (!extra) return base;
  return {
    ...base,
    spreadBps: Math.max(base.spreadBps, extra.spreadBps),
    slippageBps: Math.max(base.slippageBps, extra.slippageBps),
  };
}
