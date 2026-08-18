/**
 * Fail-closed asset classification. UNKNOWN is preferred over guessing.
 * Does not place orders. Does not import OMS / BrokerManager / RiskEngine.
 */
import {
  getAssetProfile,
  multiAssetConfig,
  type MultiAssetClass,
  type MultiAssetProfile,
} from '../config/multiAsset';

export interface AssetSnapshot {
  symbol: string;
  price?: number | null;
  marketCap?: number | null;
  averageVolume?: number | null;
  averageDollarVolume?: number | null;
  bid?: number | null;
  ask?: number | null;
  atr?: number | null;
  exchange?: string | null;
  securityType?: string | null;
}

export interface AssetClassification {
  symbol: string;
  assetClass: MultiAssetClass;
  basis: string[];
  uncalibrated: boolean;
  missingFields: string[];
  profile: MultiAssetProfile;
}

function finitePositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function classifyAsset(snapshot: AssetSnapshot): AssetClassification {
  const symbol = String(snapshot.symbol || '').trim().toUpperCase();
  const missingFields: string[] = [];
  const price = finitePositive(snapshot.price);
  const marketCap = finitePositive(snapshot.marketCap);
  const bid = finitePositive(snapshot.bid);
  const ask = finitePositive(snapshot.ask);
  if (price === null) missingFields.push('price');
  if (marketCap === null) missingFields.push('marketCap');
  if (finitePositive(snapshot.averageDollarVolume) === null) missingFields.push('averageDollarVolume');
  if (bid === null) missingFields.push('bid');
  if (ask === null) missingFields.push('ask');

  const override = multiAssetConfig.symbolOverrides[symbol];
  if (override) {
    return {
      symbol,
      assetClass: override,
      basis: [`symbolOverride:${override}`],
      uncalibrated: false,
      missingFields,
      profile: getAssetProfile(override),
    };
  }

  if (multiAssetConfig.etfSymbols.includes(symbol) || snapshot.securityType === 'ETF') {
    return {
      symbol,
      assetClass: 'ETF',
      basis: ['etfAllowlist'],
      uncalibrated: false,
      missingFields,
      profile: getAssetProfile('ETF'),
    };
  }

  const caps = multiAssetConfig.classification;
  if (marketCap !== null) {
    let assetClass: MultiAssetClass = 'UNKNOWN';
    if (marketCap >= caps.marketCapLarge) assetClass = 'LARGE_CAP';
    else if (marketCap >= caps.marketCapMid) assetClass = 'MID_CAP';
    else if (marketCap >= caps.marketCapSmall) assetClass = 'SMALL_CAP';
    else if (marketCap >= caps.marketCapMicro) assetClass = 'MICRO_CAP';
    else if (price !== null && price < caps.pennyMaxPrice) assetClass = 'PENNY_STOCK';
    else assetClass = 'UNKNOWN';
    return {
      symbol,
      assetClass,
      basis: [`marketCap:${marketCap}`],
      uncalibrated: false,
      missingFields,
      profile: getAssetProfile(assetClass),
    };
  }

  if (price !== null && price < caps.pennyMaxPrice) {
    return {
      symbol,
      assetClass: 'PENNY_STOCK',
      basis: [`priceOnly<${caps.pennyMaxPrice}`],
      uncalibrated: caps.priceOnlyPennyIsUncalibrated,
      missingFields,
      profile: getAssetProfile('PENNY_STOCK'),
    };
  }

  return {
    symbol,
    assetClass: 'UNKNOWN',
    basis: ['UNKNOWN_preferred_over_guessing'],
    uncalibrated: false,
    missingFields,
    profile: getAssetProfile('UNKNOWN'),
  };
}

export function isPennyOrMicro(assetClass: MultiAssetClass): boolean {
  return assetClass === 'PENNY_STOCK' || assetClass === 'MICRO_CAP';
}
