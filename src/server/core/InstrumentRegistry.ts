/**
 * ARGUS Crypto Expansion Phase 1 (2026-09-21). Canonical cross-asset instrument validation.
 *
 * looksLikeListedTicker() (ai/AIOutputValidator.ts) is a pure equity-ticker-shape regex
 * (^[A-Z]{1,5}(\.[A-Z])?$) with 24 real callers across discovery/news/market-data/risk. It is
 * NOT modified here - the 2026-09-21 crypto forensic audit found it structurally rejects every
 * realistic crypto pair format (BTC-USD, BTC/USD, BTCUSD all fail), and blindly loosening it in
 * place would weaken RiskEngine gate 15 and every other caller at once with no way to reason
 * about the blast radius per-caller. validateInstrumentSymbol() below is additive: equity symbols
 * go through the exact existing equity path unchanged; a small, explicit CRYPTO branch checks the
 * canonical registry (config/cryptoInstruments.ts) instead of a permissive regex, so an arbitrary
 * hyphenated string can never pass just by "looking crypto-shaped" - only BTC-USD/ETH-USD (or
 * whatever is explicitly registered) can.
 *
 * Scope note (Phase 1-2): migrated at RiskEngine.ts's price_validity gate (gate 15),
 * tradeIdeaContract.ts's gateTradeIdea() (DEF-24), and QuantCoreBridge.ts's onSignal(). The other
 * ~21 remaining looksLikeListedTicker() callers (OpportunityDiscovery, NewsEngine,
 * MarketDataWorker, ...) are untouched by design - no caller in this codebase currently emits a
 * crypto TRADE_IDEA_GENERATED event through them, so widening them is unnecessary work with real
 * regression risk for zero present benefit. See docs/architecture/ARGUS_ARCHITECTURE.md's Crypto
 * Expansion sections for the full caller survey and what remains for a future idea-wiring phase.
 *
 * "What to trade" selector (2026-09-22): every check here is additionally gated by
 * isAssetClassTradeable() (config/tradeableAssetClasses.ts) - an operator can disable EQUITY,
 * CRYPTO, or neither via ARGUS_TRADEABLE_ASSET_CLASSES (env, hot-reloadable via the real
 * EnvRuntimeSettingsPanel.tsx UI). Default is EQUITY-only, so this is a no-op for every existing
 * deployment until an operator explicitly opts CRYPTO in.
 */
import { looksLikeListedTicker } from '../ai/AIOutputValidator';
import { getCryptoInstrument, type AssetClass } from '../config/cryptoInstruments';
import { isAssetClassTradeable } from '../config/tradeableAssetClasses';

export interface InstrumentValidationResult {
  valid: boolean;
  canonicalSymbol: string | null;
  assetClass: AssetClass | null;
  reason: string | null;
}

/**
 * Equity path: byte-for-byte looksLikeListedTicker() behavior, unchanged.
 * Crypto path: exact canonical-symbol match against config/cryptoInstruments.json only - never a
 * "contains a hyphen" heuristic. An unregistered crypto-shaped string (e.g. DOG-FAKE) fails
 * closed, same as a malformed one.
 */
export function validateInstrumentSymbol(raw: unknown): InstrumentValidationResult {
  const equityTicker = looksLikeListedTicker(raw);
  if (equityTicker) {
    if (!isAssetClassTradeable('EQUITY')) {
      return { valid: false, canonicalSymbol: null, assetClass: null, reason: 'ASSET_CLASS_NOT_TRADEABLE' };
    }
    return { valid: true, canonicalSymbol: equityTicker, assetClass: 'EQUITY', reason: null };
  }

  if (typeof raw !== 'string' || !raw.trim()) {
    return { valid: false, canonicalSymbol: null, assetClass: null, reason: 'EMPTY_SYMBOL' };
  }
  const candidate = raw.trim().toUpperCase();
  const instrument = getCryptoInstrument(candidate);
  if (instrument && instrument.canonicalSymbol === candidate) {
    if (!isAssetClassTradeable('CRYPTO')) {
      return { valid: false, canonicalSymbol: null, assetClass: null, reason: 'ASSET_CLASS_NOT_TRADEABLE' };
    }
    return { valid: true, canonicalSymbol: instrument.canonicalSymbol, assetClass: 'CRYPTO', reason: null };
  }

  return { valid: false, canonicalSymbol: null, assetClass: null, reason: 'UNREGISTERED_OR_MALFORMED_SYMBOL' };
}
