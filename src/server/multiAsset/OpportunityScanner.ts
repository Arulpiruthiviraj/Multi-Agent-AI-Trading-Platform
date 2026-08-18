/**
 * Research/signal scanner only. Produces OPPORTUNITY, never ORDER.
 * Does not import OMS, BrokerManager, RiskEngine, or EventBus.
 */
import { isPennyStockEnabled } from '../config/multiAsset';
import { classifyAsset, isPennyOrMicro, type AssetSnapshot } from './AssetClassifier';
import { evaluateAssetSafety } from './SafetyFilter';
import { strategyPermissionForAsset } from './StrategyRouter';

export interface AssetOpportunity {
  symbol: string;
  assetClass: string;
  safety: 'SAFE' | 'WATCH' | 'BLOCK';
  eligibleForTradeIdea: boolean;
  reasons: string[];
  classificationBasis: string[];
  uncalibrated: boolean;
  missingFields: string[];
  liveStrategyPermission: 'UNRESTRICTED' | 'ALLOWLIST' | 'NONE';
  permittedStrategyIds: string[] | null;
  honesty: string;
}

const HONESTY = 'OPPORTUNITY only — not a trade idea, not an order. Scanner cannot place orders.';

export function scanAssetOpportunity(snapshot: AssetSnapshot): AssetOpportunity {
  const classification = classifyAsset(snapshot);
  const safety = evaluateAssetSafety(snapshot, classification);
  const permission = strategyPermissionForAsset(classification.assetClass);
  const liveStrategyPermission =
    permission.mode === 'UNRESTRICTED'
      ? 'UNRESTRICTED'
      : permission.ids.length === 0
        ? 'NONE'
        : 'ALLOWLIST';
  const restrictedActive = isPennyStockEnabled() && isPennyOrMicro(classification.assetClass);
  const blocked = restrictedActive && safety.verdict === 'BLOCK';

  return {
    symbol: classification.symbol,
    assetClass: classification.assetClass,
    safety: blocked ? 'BLOCK' : restrictedActive ? safety.verdict : 'SAFE',
    eligibleForTradeIdea: !blocked,
    reasons: restrictedActive ? safety.reasons : ['passthrough_overlay_or_non_restricted_class'],
    classificationBasis: classification.basis,
    uncalibrated: classification.uncalibrated,
    missingFields: classification.missingFields,
    liveStrategyPermission,
    permittedStrategyIds: permission.mode === 'ALLOWLIST' ? permission.ids : null,
    honesty: HONESTY,
  };
}
