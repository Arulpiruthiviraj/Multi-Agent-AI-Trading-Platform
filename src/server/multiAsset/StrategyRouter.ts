/**
 * Asset-aware strategy eligibility. null permittedStrategyIds = unrestricted (existing live set).
 * Empty array = no live strategy auto-enabled for that class.
 * Does not place orders. Does not enable QUANT_ENGINE_ENABLED.
 */
import { getAssetProfile, isPennyStockEnabled, type MultiAssetClass } from '../config/multiAsset';
import { isPennyOrMicro } from './AssetClassifier';

export type StrategyPermission = { mode: 'UNRESTRICTED' } | { mode: 'ALLOWLIST'; ids: string[] };

export function strategyPermissionForAsset(assetClass?: MultiAssetClass | string | null): StrategyPermission {
  if (!isPennyStockEnabled()) return { mode: 'UNRESTRICTED' };
  if (!assetClass || !isPennyOrMicro(assetClass as MultiAssetClass)) return { mode: 'UNRESTRICTED' };
  const profile = getAssetProfile(assetClass as MultiAssetClass);
  if (profile.permittedStrategyIds === null) return { mode: 'UNRESTRICTED' };
  return { mode: 'ALLOWLIST', ids: profile.permittedStrategyIds };
}

export function filterStrategiesForAsset<T extends { id: string }>(
  strategies: T[],
  assetClass?: MultiAssetClass | string | null,
): T[] {
  const permission = strategyPermissionForAsset(assetClass);
  if (permission.mode === 'UNRESTRICTED') return strategies;
  return strategies.filter((s) => permission.ids.includes(s.id));
}

export function isStrategyEligibleForAsset(strategyId: string, assetClass?: MultiAssetClass | string | null): boolean {
  const permission = strategyPermissionForAsset(assetClass);
  if (permission.mode === 'UNRESTRICTED') return true;
  return permission.ids.includes(strategyId);
}
