/**
 * symbolFormat.ts - cheap, conservative format gate for symbols before they reach a historical-data provider.
 *
 * 2026-10-13: ten IBKR "No security definition" rejections came from news-derived company names (INTEL, SMSC,
 * WALMART, ARCHER AVIATION, RNO, KWMN) reaching reqHistoricalData. A format check cannot prove a string is a real
 * security (INTEL is five plain letters), so this only rejects what can NEVER be a ticker - spaces, punctuation, empty,
 * absurdly long - and the IBKR contract-resolution negative cache (recordIbkrContractNotFound)
 * catches the rest after the first rejection. Legitimate formats stay valid: AAPL, BRK.B, BF-B, 1-6 character
 * symbols with an optional share-class/pair suffix.
 */
const TICKER_FORMAT = /^[A-Z0-9]{1,16}([./-][A-Z0-9]{1,16})?$/;

import { loadRepoConfigJson } from '../config/loadRepoConfigJson';

interface SymbolRoutingConfig {
  reservedPlaceholderTokens: string[];
  testOnlyDiagnosticPrefixPatterns: string[];
  cashIndexIdentifiers: string[];
  fxCurrencyCodes: string[];
}
const routing = loadRepoConfigJson<SymbolRoutingConfig>('symbolRouting.json');
const RESERVED = new Set(routing.reservedPlaceholderTokens.map((s) => s.toUpperCase()));
const DIAGNOSTIC_PATTERNS = routing.testOnlyDiagnosticPrefixPatterns.map((p) => new RegExp(p));
const CASH_INDEXES = new Set(routing.cashIndexIdentifiers.map((s) => s.toUpperCase()));
const FX_PAIR = new RegExp(`^(?:${routing.fxCurrencyCodes.join('|')})(?:${routing.fxCurrencyCodes.join('|')})$`);

export type EquityRoutingVerdict =
  | { routable: true }
  | { routable: false; reason: 'NOT_A_STRING' | 'MALFORMED' | 'RESERVED_PLACEHOLDER' | 'TEST_ONLY_DIAGNOSTIC' | 'CASH_INDEX' | 'FX_PAIR' };

/**
 * 2026-10-13: may this identifier be sent to IBKR as a STK (equity) contract? Stricter than the pure format gate:
 * it also rejects placeholder tokens (NULL/NONE), test-only diagnostic symbols (DIAGTEST<ts>), cash indices (SPX)
 * and FX pairs (USDJPY) - identifiers whose asset class is provably not US equity. Configuration: config/symbolRouting.json.
 */
export function classifyEquityRouting(raw: unknown): EquityRoutingVerdict {
  if (typeof raw !== 'string') return { routable: false, reason: 'NOT_A_STRING' };
  const s = raw.toUpperCase();
  // Most specific reason first: a 21-character DIAGTEST<ts> is also over-length, but "test-only diagnostic" is the useful answer.
  if (DIAGNOSTIC_PATTERNS.some((re) => re.test(s))) return { routable: false, reason: 'TEST_ONLY_DIAGNOSTIC' };
  if (!isPlausibleHistoricalSymbol(raw)) return { routable: false, reason: 'MALFORMED' };
  if (RESERVED.has(s)) return { routable: false, reason: 'RESERVED_PLACEHOLDER' };
  if (CASH_INDEXES.has(s)) return { routable: false, reason: 'CASH_INDEX' };
  if (s.length === 6 && FX_PAIR.test(s)) return { routable: false, reason: 'FX_PAIR' };
  return { routable: true };
}

export function isRoutableEquitySymbol(raw: unknown): boolean {
  return classifyEquityRouting(raw).routable;
}

/** Stricter check for rows read back from storage: Argus normalizes symbols to upper case on ingestion, so a
 *  mixed-case value ("Walmart", " Archer Aviation") is a legacy pre-DEF-24 extraction, never a real ticker. */
export function isCanonicalStoredSymbol(raw: unknown): boolean {
  return typeof raw === 'string' && raw === raw.toUpperCase() && isPlausibleHistoricalSymbol(raw);
}

export function isPlausibleHistoricalSymbol(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  if (raw !== raw.trim()) return false; // leading/trailing whitespace is a malformed extraction, not a ticker
  return TICKER_FORMAT.test(raw.toUpperCase());
}
