/**
 * Pre-ChiefTrader eligibility for TRADE_IDEA_GENERATED.
 * Flags off → identity. SELL/exits passthrough. Never calls placeOrder.
 */
import { isMultiAssetEnabled, isPennyStockEnabled } from '../config/multiAsset';
import { classifyAsset, isPennyOrMicro, type AssetSnapshot } from './AssetClassifier';
import { evaluateAssetSafety } from './SafetyFilter';

export interface IdeaEligibilityInput {
  symbol?: string;
  side?: string;
  currentPrice?: number;
  bid?: number | null;
  ask?: number | null;
  averageDollarVolume?: number | null;
  atr?: number | null;
  marketCap?: number | null;
}

export type IdeaEligibility =
  | { ok: true; idea: Record<string, unknown> }
  | { ok: false; reason: string; reasons: string[]; symbol: string; assetClass: string };

export function applyAssetIdeaGate(idea: Record<string, unknown> | null | undefined): IdeaEligibility {
  const payload = { ...(idea || {}) };
  const symbol = String(payload.symbol || '');
  if (!isMultiAssetEnabled()) {
    return { ok: true, idea: payload };
  }

  const snapshot: AssetSnapshot = {
    symbol,
    price: typeof payload.currentPrice === 'number' ? payload.currentPrice : null,
    bid: typeof payload.bid === 'number' ? payload.bid : null,
    ask: typeof payload.ask === 'number' ? payload.ask : null,
    averageDollarVolume: typeof payload.averageDollarVolume === 'number' ? payload.averageDollarVolume : null,
    atr: typeof payload.atr === 'number' ? payload.atr : null,
    marketCap: typeof payload.marketCap === 'number' ? payload.marketCap : null,
  };
  const classification = classifyAsset(snapshot);
  payload.assetClass = classification.assetClass;
  payload.assetClassificationBasis = classification.basis;
  payload.assetClassificationUncalibrated = classification.uncalibrated;

  const side = String(payload.side || '').toUpperCase();
  if (side === 'SELL') {
    return { ok: true, idea: payload };
  }

  if (!isPennyStockEnabled() || !isPennyOrMicro(classification.assetClass)) {
    return { ok: true, idea: payload };
  }

  const safety = evaluateAssetSafety(snapshot, classification);
  if (safety.verdict === 'BLOCK') {
    return {
      ok: false,
      reason: safety.reasons[0] || 'ASSET_CLASS_BLOCKED',
      reasons: safety.reasons,
      symbol,
      assetClass: classification.assetClass,
    };
  }
  payload.assetSafety = safety.verdict;
  payload.assetSafetyReasons = safety.reasons;
  return { ok: true, idea: payload };
}

export function applySubordinateAssetNotionalCap(args: {
  symbol: string;
  currentPrice: number;
  maxTradeSizeDollar: number;
}): number {
  const global = args.maxTradeSizeDollar;
  if (!isPennyStockEnabled()) return global;
  const classification = classifyAsset({ symbol: args.symbol, price: args.currentPrice });
  const cap = classification.profile.maxPositionNotional;
  if (cap === null || !Number.isFinite(cap) || cap <= 0) return global;
  return Math.min(global, cap);
}
