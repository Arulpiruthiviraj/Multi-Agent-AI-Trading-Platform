/**
 * Asset-class risk filter. SAFE / WATCH / BLOCK.
 * BLOCK is a candidate filter, not a manipulation detector.
 * Does not place orders.
 */
import { multiAssetConfig, type MultiAssetClass } from '../config/multiAsset';
import { classifyAsset, isPennyOrMicro, type AssetSnapshot, type AssetClassification } from './AssetClassifier';

export type SafetyVerdict = 'SAFE' | 'WATCH' | 'BLOCK';

export interface SafetyFilterResult {
  verdict: SafetyVerdict;
  reasons: string[];
  classification: AssetClassification;
  spreadAbs: number | null;
  spreadBps: number | null;
  dollarVolume: number | null;
}

function finitePositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function evaluateAssetSafety(
  snapshot: AssetSnapshot,
  classification: AssetClassification = classifyAsset(snapshot),
): SafetyFilterResult {
  const reasons: string[] = [];
  const bid = finitePositive(snapshot.bid);
  const ask = finitePositive(snapshot.ask);
  const price = finitePositive(snapshot.price);
  const dollarVolume = finitePositive(snapshot.averageDollarVolume);
  const atr = finitePositive(snapshot.atr);
  let spreadAbs: number | null = null;
  let spreadBps: number | null = null;
  if (bid !== null && ask !== null && ask >= bid) {
    spreadAbs = ask - bid;
    const mid = (ask + bid) / 2;
    spreadBps = mid > 0 ? (spreadAbs / mid) * 10000 : null;
  }

  if (!isPennyOrMicro(classification.assetClass)) {
    return {
      verdict: 'SAFE',
      reasons: ['passthrough_non_penny_micro'],
      classification,
      spreadAbs,
      spreadBps,
      dollarVolume,
    };
  }

  const safety = multiAssetConfig.safety;
  if (spreadAbs === null || spreadBps === null) {
    reasons.push('ASSET_SPREAD_UNKNOWN');
  } else {
    if (spreadAbs > safety.pennyMaxSpreadAbs) reasons.push('ASSET_EXCESSIVE_SPREAD');
    if (spreadBps > safety.pennyMaxSpreadBps) reasons.push('ASSET_EXCESSIVE_SPREAD_BPS');
  }
  if (dollarVolume === null) reasons.push('ASSET_DOLLAR_VOLUME_UNKNOWN');
  else if (dollarVolume < safety.pennyMinDollarVolume) reasons.push('POOR_LIQUIDITY');
  if (price !== null && atr !== null && price > 0 && atr / price > safety.pennyMaxAtrPct) {
    reasons.push('EXCESSIVE_VOLATILITY');
  }
  if (!multiAssetConfig.execution.marketOrdersFitPennyAndMicro) {
    reasons.push('ASSET_MARKET_ORDER_UNFIT');
  }

  const blocking = reasons.some((r) =>
    r === 'ASSET_SPREAD_UNKNOWN'
    || r === 'ASSET_EXCESSIVE_SPREAD'
    || r === 'ASSET_EXCESSIVE_SPREAD_BPS'
    || r === 'ASSET_DOLLAR_VOLUME_UNKNOWN'
    || r === 'POOR_LIQUIDITY'
    || r === 'EXCESSIVE_VOLATILITY'
    || r === 'ASSET_MARKET_ORDER_UNFIT',
  );

  return {
    verdict: blocking ? 'BLOCK' : 'SAFE',
    reasons: reasons.length > 0 ? reasons : ['penny_safety_cleared'],
    classification,
    spreadAbs,
    spreadBps,
    dollarVolume,
  };
}

export function restrictedAssetClasses(): MultiAssetClass[] {
  return ['PENNY_STOCK', 'MICRO_CAP'];
}
