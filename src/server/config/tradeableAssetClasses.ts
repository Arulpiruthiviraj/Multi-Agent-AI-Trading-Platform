/**
 * ARGUS Crypto Expansion mandate (2026-09-22). "Through env variable and UI what to trade can be
 * selected - stocks and crypto, or just stock, or just crypto" (explicit operator instruction).
 *
 * Reuses the existing env->DB-override->UI resolution pipeline (effectiveRuntimeConfig.ts +
 * config/runtimeEnvCatalog.json's ARGUS_TRADEABLE_ASSET_CLASSES entry, rendered today by the real
 * EnvRuntimeSettingsPanel.tsx UI, edited via the real POST /api/v2/settings/overrides route) rather
 * than inventing a second settings mechanism. Same "read live on every call" contract every other
 * isRuntimeFlagEnabled() consumer already relies on - hot-reloadable, no restart needed.
 *
 * Default is 'EQUITY' only, matching this codebase's own crypto-off-by-default convention: every
 * existing deployment keeps its exact current behavior (crypto symbols were already invalid before
 * Phase 1-13 existed) until an operator explicitly opts CRYPTO in here.
 */
import { resolveRuntimeSetting } from './effectiveRuntimeConfig';
import type { AssetClass } from './cryptoInstruments';

const CATALOG_KEY = 'ARGUS_TRADEABLE_ASSET_CLASSES';

function parseTradeableAssetClasses(raw: string): Set<AssetClass> {
  const tokens = raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const result = new Set<AssetClass>();
  for (const t of tokens) {
    if (t === 'EQUITY' || t === 'CRYPTO') result.add(t);
  }
  return result;
}

/** Real, live-read set - never cached beyond what effectiveRuntimeConfig.ts's own overrideCache
 *  already provides (which setRuntimeOverride()/resetRuntimeOverride() keep correct on every
 *  write). Falls back to EQUITY-only if the catalog entry is somehow unresolvable. */
export function getTradeableAssetClasses(): Set<AssetClass> {
  const resolved = resolveRuntimeSetting(CATALOG_KEY);
  const raw = typeof resolved?.effectiveValue === 'string' ? resolved.effectiveValue : 'EQUITY';
  const parsed = parseTradeableAssetClasses(raw);
  return parsed.size > 0 ? parsed : new Set<AssetClass>(['EQUITY']);
}

export function isAssetClassTradeable(assetClass: AssetClass): boolean {
  return getTradeableAssetClasses().has(assetClass);
}
