/**
 * ARGUS Crypto Expansion Phase 1 (2026-09-21). Loads config/cryptoInstruments.json - the
 * canonical BTC-USD/ETH-USD instrument registry. Same loader pattern as multiAsset.ts (missing
 * required keys fail boot). This is a DISTINCT concept from multiAsset.ts's `MultiAssetClass`
 * (LARGE_CAP/MID_CAP/.../PENNY_STOCK) - that type is an equity liquidity-tier classifier, not a
 * cross-asset-class model. Deliberately not reused/extended here (see the 2026-09-21 crypto
 * forensic audit's "asset-class model" finding).
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';
import { isRuntimeFlagEnabled } from './effectiveRuntimeConfig';

export const ASSET_CLASSES = ['EQUITY', 'CRYPTO'] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export interface CryptoInstrumentDefinition {
  canonicalSymbol: string;
  assetClass: 'CRYPTO';
  baseAsset: string;
  quoteAsset: string;
  pricePrecision: number;
  quantityPrecision: number;
  /** Smallest tradable quantity increment. Quantities are always rounded DOWN to this step
   *  (never up - see quantizeQuantityDown in engines/QuantityQuantization.ts). */
  quantityStep: number;
  minimumQuantity: number;
  minimumNotional: number;
  enabledForResearch: boolean;
  enabledForPaper: boolean;
}

function requirePositiveNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`config/cryptoInstruments.json ${label} must be a positive finite number`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`config/cryptoInstruments.json ${label} must be a non-empty string`);
  }
  return value.trim();
}

function parseInstrument(raw: unknown, index: number): CryptoInstrumentDefinition {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`config/cryptoInstruments.json instruments[${index}] is not an object`);
  }
  const row = raw as Record<string, unknown>;
  const canonicalSymbol = requireNonEmptyString(row.canonicalSymbol, `instruments[${index}].canonicalSymbol`).toUpperCase();
  if (row.assetClass !== 'CRYPTO') {
    throw new Error(`config/cryptoInstruments.json instruments[${index}].assetClass must be "CRYPTO" (this registry is crypto-only)`);
  }
  return {
    canonicalSymbol,
    assetClass: 'CRYPTO',
    baseAsset: requireNonEmptyString(row.baseAsset, `instruments[${index}].baseAsset`).toUpperCase(),
    quoteAsset: requireNonEmptyString(row.quoteAsset, `instruments[${index}].quoteAsset`).toUpperCase(),
    pricePrecision: requirePositiveNumber(row.pricePrecision, `instruments[${index}].pricePrecision`),
    quantityPrecision: requirePositiveNumber(row.quantityPrecision, `instruments[${index}].quantityPrecision`),
    quantityStep: requirePositiveNumber(row.quantityStep, `instruments[${index}].quantityStep`),
    minimumQuantity: requirePositiveNumber(row.minimumQuantity, `instruments[${index}].minimumQuantity`),
    minimumNotional: requirePositiveNumber(row.minimumNotional, `instruments[${index}].minimumNotional`),
    enabledForResearch: row.enabledForResearch === true,
    enabledForPaper: row.enabledForPaper === true,
  };
}

export interface CryptoPaperExecutionAssumptions {
  spreadBps: number;
  feeBps: number;
  slippageBps: number;
  maxFillNotionalPerTick: number;
}

function parsePaperExecution(raw: unknown): CryptoPaperExecutionAssumptions {
  if (!raw || typeof raw !== 'object') {
    throw new Error('config/cryptoInstruments.json missing paperExecution');
  }
  const row = raw as Record<string, unknown>;
  return {
    spreadBps: requirePositiveNumber(row.spreadBps, 'paperExecution.spreadBps'),
    feeBps: requirePositiveNumber(row.feeBps, 'paperExecution.feeBps'),
    slippageBps: requirePositiveNumber(row.slippageBps, 'paperExecution.slippageBps'),
    maxFillNotionalPerTick: requirePositiveNumber(row.maxFillNotionalPerTick, 'paperExecution.maxFillNotionalPerTick'),
  };
}

function loadCryptoInstruments(): {
  registry: Map<string, CryptoInstrumentDefinition>;
  ingestionEnabledEnvVar: string;
  paperExecution: CryptoPaperExecutionAssumptions;
} {
  const raw = loadRepoConfigJson<Record<string, unknown>>('cryptoInstruments.json');
  if (!Array.isArray(raw.instruments)) {
    throw new Error('config/cryptoInstruments.json missing instruments[]');
  }
  const ingestionEnabledEnvVar = requireNonEmptyString(raw.cryptoMarketDataIngestionEnabledEnvVar, 'cryptoMarketDataIngestionEnabledEnvVar');
  const paperExecution = parsePaperExecution(raw.paperExecution);
  const map = new Map<string, CryptoInstrumentDefinition>();
  raw.instruments.forEach((entry, i) => {
    const instrument = parseInstrument(entry, i);
    if (map.has(instrument.canonicalSymbol)) {
      throw new Error(`config/cryptoInstruments.json duplicate canonicalSymbol ${instrument.canonicalSymbol}`);
    }
    map.set(instrument.canonicalSymbol, instrument);
  });
  return { registry: map, ingestionEnabledEnvVar, paperExecution };
}

const {
  registry: cryptoInstrumentRegistry,
  ingestionEnabledEnvVar: CRYPTO_MARKET_DATA_INGESTION_ENABLED_ENV_VAR,
  paperExecution: cryptoPaperExecutionAssumptions,
} = loadCryptoInstruments();

/** Crypto Expansion Phase 13 (2026-09-22). CryptoPaperBroker.ts's fill-model assumptions. */
export function getCryptoPaperExecutionAssumptions(): CryptoPaperExecutionAssumptions {
  return cryptoPaperExecutionAssumptions;
}

/** Crypto Expansion Phase 4 (2026-09-21). Off by default - opt-in, same pattern as
 *  isOpportunityLoopEnabled()/isMultiAssetEnabled(). */
export function isCryptoMarketDataIngestionEnabled(): boolean {
  return isRuntimeFlagEnabled(CRYPTO_MARKET_DATA_INGESTION_ENABLED_ENV_VAR);
}

/** Exact canonical-symbol lookup only (e.g. "BTC-USD") - never a fuzzy/provider-notation match.
 *  Provider-specific forms (BTC/USD, BTCUSD, XBTUSD, ...) are adapter concerns, not registry
 *  concerns (mandate section 6). Returns null for anything unregistered, including equities. */
export function getCryptoInstrument(canonicalSymbol: string): CryptoInstrumentDefinition | null {
  return cryptoInstrumentRegistry.get(String(canonicalSymbol || '').trim().toUpperCase()) ?? null;
}

export function isRegisteredCryptoInstrument(canonicalSymbol: string): boolean {
  return cryptoInstrumentRegistry.has(String(canonicalSymbol || '').trim().toUpperCase());
}

export function listCryptoInstruments(): CryptoInstrumentDefinition[] {
  return Array.from(cryptoInstrumentRegistry.values());
}
