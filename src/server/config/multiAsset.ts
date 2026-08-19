/**
 * Load config/multiAsset.json. Missing required keys fail boot.
 * Thresholds are UNCALIBRATED. This file does not enable the overlay.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';
import { isRuntimeFlagEnabled } from './effectiveRuntimeConfig';

export const MULTI_ASSET_CLASSES = [
  'LARGE_CAP',
  'MID_CAP',
  'SMALL_CAP',
  'MICRO_CAP',
  'PENNY_STOCK',
  'ETF',
  'UNKNOWN',
] as const;

export type MultiAssetClass = (typeof MULTI_ASSET_CLASSES)[number];

export interface MultiAssetResearchCosts {
  spreadBps: number;
  slippageBps: number;
}

export interface MultiAssetProfile {
  permittedStrategyIds: string[] | null;
  maxPositionNotional: number | null;
  maxConcentrationPct: number | null;
  researchCosts: MultiAssetResearchCosts | null;
}

export interface MultiAssetConfig {
  multiAssetEnabledEnvVar: string;
  pennyStockEnabledEnvVar: string;
  assetClasses: MultiAssetClass[];
  unknownPolicy: 'PASSTHROUGH';
  etfSymbols: string[];
  symbolOverrides: Record<string, MultiAssetClass>;
  classification: {
    pennyMaxPrice: number;
    marketCapLarge: number;
    marketCapMid: number;
    marketCapSmall: number;
    marketCapMicro: number;
    priceOnlyPennyIsUncalibrated: boolean;
  };
  execution: {
    omsOrderTypeIsMarketOnly: boolean;
    marketOrdersFitPennyAndMicro: boolean;
    marketUnfitReason: string;
  };
  safety: {
    pennyMinDollarVolume: number;
    pennyMaxSpreadBps: number;
    pennyMaxSpreadAbs: number;
    pennyMaxAtrPct: number;
    calibration: string;
  };
  profiles: Record<MultiAssetClass, MultiAssetProfile>;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`config/multiAsset.json ${label} must be a finite number`);
  }
  return value;
}

function parseClass(value: unknown, label: string): MultiAssetClass {
  if (typeof value !== 'string' || !(MULTI_ASSET_CLASSES as readonly string[]).includes(value)) {
    throw new Error(`config/multiAsset.json ${label} is not a known asset class`);
  }
  return value as MultiAssetClass;
}

function parseProfile(raw: unknown, classId: MultiAssetClass): MultiAssetProfile {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`config/multiAsset.json profiles.${classId} missing`);
  }
  const row = raw as Record<string, unknown>;
  let permittedStrategyIds: string[] | null = null;
  if (row.permittedStrategyIds === null) {
    permittedStrategyIds = null;
  } else if (Array.isArray(row.permittedStrategyIds)) {
    permittedStrategyIds = row.permittedStrategyIds.map((id) => {
      if (typeof id !== 'string' || !id) {
        throw new Error(`config/multiAsset.json profiles.${classId}.permittedStrategyIds entries must be strings`);
      }
      return id;
    });
  } else {
    throw new Error(`config/multiAsset.json profiles.${classId}.permittedStrategyIds must be null or string[]`);
  }
  const maxPositionNotional = row.maxPositionNotional === null ? null : requireNumber(row.maxPositionNotional, `profiles.${classId}.maxPositionNotional`);
  const maxConcentrationPct = row.maxConcentrationPct === null ? null : requireNumber(row.maxConcentrationPct, `profiles.${classId}.maxConcentrationPct`);
  let researchCosts: MultiAssetResearchCosts | null = null;
  if (row.researchCosts !== null && row.researchCosts !== undefined) {
    if (!row.researchCosts || typeof row.researchCosts !== 'object') {
      throw new Error(`config/multiAsset.json profiles.${classId}.researchCosts invalid`);
    }
    const costs = row.researchCosts as Record<string, unknown>;
    researchCosts = {
      spreadBps: requireNumber(costs.spreadBps, `profiles.${classId}.researchCosts.spreadBps`),
      slippageBps: requireNumber(costs.slippageBps, `profiles.${classId}.researchCosts.slippageBps`),
    };
  }
  return { permittedStrategyIds, maxPositionNotional, maxConcentrationPct, researchCosts };
}

function loadMultiAssetConfig(): MultiAssetConfig {
  const raw = loadRepoConfigJson<Record<string, unknown>>('multiAsset.json');
  if (typeof raw.multiAssetEnabledEnvVar !== 'string' || !raw.multiAssetEnabledEnvVar) {
    throw new Error('config/multiAsset.json missing multiAssetEnabledEnvVar');
  }
  if (typeof raw.pennyStockEnabledEnvVar !== 'string' || !raw.pennyStockEnabledEnvVar) {
    throw new Error('config/multiAsset.json missing pennyStockEnabledEnvVar');
  }
  if (raw.unknownPolicy !== 'PASSTHROUGH') {
    throw new Error('config/multiAsset.json unknownPolicy must be PASSTHROUGH so AAPL/QQQ/IWM do not regress when classification is incomplete');
  }
  if (!Array.isArray(raw.etfSymbols) || raw.etfSymbols.some((s) => typeof s !== 'string')) {
    throw new Error('config/multiAsset.json etfSymbols must be string[]');
  }
  if (!raw.classification || typeof raw.classification !== 'object') {
    throw new Error('config/multiAsset.json missing classification');
  }
  const classificationRaw = raw.classification as Record<string, unknown>;
  const executionRaw = raw.execution as Record<string, unknown> | undefined;
  if (!executionRaw) throw new Error('config/multiAsset.json missing execution');
  const safetyRaw = raw.safety as Record<string, unknown> | undefined;
  if (!safetyRaw) throw new Error('config/multiAsset.json missing safety');
  const profilesRaw = raw.profiles as Record<string, unknown> | undefined;
  if (!profilesRaw) throw new Error('config/multiAsset.json missing profiles');

  const assetClasses = (Array.isArray(raw.assetClasses) ? raw.assetClasses : []).map((c, i) => parseClass(c, `assetClasses[${i}]`));
  if (assetClasses.length !== MULTI_ASSET_CLASSES.length) {
    throw new Error('config/multiAsset.json assetClasses must list every class');
  }

  const symbolOverrides: Record<string, MultiAssetClass> = {};
  if (!raw.symbolOverrides || typeof raw.symbolOverrides !== 'object') {
    throw new Error('config/multiAsset.json missing symbolOverrides');
  }
  for (const [sym, cls] of Object.entries(raw.symbolOverrides as Record<string, unknown>)) {
    symbolOverrides[sym.toUpperCase()] = parseClass(cls, `symbolOverrides.${sym}`);
  }

  const profiles = {} as Record<MultiAssetClass, MultiAssetProfile>;
  for (const classId of MULTI_ASSET_CLASSES) {
    profiles[classId] = parseProfile(profilesRaw[classId], classId);
  }

  return {
    multiAssetEnabledEnvVar: raw.multiAssetEnabledEnvVar,
    pennyStockEnabledEnvVar: raw.pennyStockEnabledEnvVar,
    assetClasses,
    unknownPolicy: 'PASSTHROUGH',
    etfSymbols: (raw.etfSymbols as string[]).map((s) => s.toUpperCase()),
    symbolOverrides,
    classification: {
      pennyMaxPrice: requireNumber(classificationRaw.pennyMaxPrice, 'classification.pennyMaxPrice'),
      marketCapLarge: requireNumber(classificationRaw.marketCapLarge, 'classification.marketCapLarge'),
      marketCapMid: requireNumber(classificationRaw.marketCapMid, 'classification.marketCapMid'),
      marketCapSmall: requireNumber(classificationRaw.marketCapSmall, 'classification.marketCapSmall'),
      marketCapMicro: requireNumber(classificationRaw.marketCapMicro, 'classification.marketCapMicro'),
      priceOnlyPennyIsUncalibrated: classificationRaw.priceOnlyPennyIsUncalibrated === true,
    },
    execution: {
      omsOrderTypeIsMarketOnly: executionRaw.omsOrderTypeIsMarketOnly === true,
      marketOrdersFitPennyAndMicro: executionRaw.marketOrdersFitPennyAndMicro === true,
      marketUnfitReason: typeof executionRaw.marketUnfitReason === 'string' ? executionRaw.marketUnfitReason : 'MARKET unfit',
    },
    safety: {
      pennyMinDollarVolume: requireNumber(safetyRaw.pennyMinDollarVolume, 'safety.pennyMinDollarVolume'),
      pennyMaxSpreadBps: requireNumber(safetyRaw.pennyMaxSpreadBps, 'safety.pennyMaxSpreadBps'),
      pennyMaxSpreadAbs: requireNumber(safetyRaw.pennyMaxSpreadAbs, 'safety.pennyMaxSpreadAbs'),
      pennyMaxAtrPct: requireNumber(safetyRaw.pennyMaxAtrPct, 'safety.pennyMaxAtrPct'),
      calibration: typeof safetyRaw.calibration === 'string' ? safetyRaw.calibration : 'UNCALIBRATED',
    },
    profiles,
  };
}

export const multiAssetConfig: MultiAssetConfig = loadMultiAssetConfig();

export function isMultiAssetEnabled(): boolean {
  return isRuntimeFlagEnabled(multiAssetConfig.multiAssetEnabledEnvVar);
}

export function isPennyStockEnabled(): boolean {
  return isMultiAssetEnabled() && isRuntimeFlagEnabled(multiAssetConfig.pennyStockEnabledEnvVar);
}

export function getAssetProfile(assetClass: MultiAssetClass): MultiAssetProfile {
  return multiAssetConfig.profiles[assetClass];
}
